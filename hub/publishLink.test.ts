// hub/publishLink.test.ts
import { test, expect } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { inferModeAndType, publishArtifact, type PublishOpts, type PublishIO } from "./publishLink"

test("inferModeAndType maps extensions to mode + contentType", () => {
  expect(inferModeAndType("a.pdf")).toEqual({ mode: "view", contentType: "application/pdf" })
  expect(inferModeAndType("a.html")).toEqual({ mode: "page", contentType: "text/html" })
  expect(inferModeAndType("a.md")).toEqual({ mode: "view", contentType: "text/markdown" })
  expect(inferModeAndType("a.csv")).toEqual({ mode: "view", contentType: "text/csv" })
  expect(inferModeAndType("a.bin")).toEqual({ mode: "download", contentType: "application/octet-stream" })
})

function outbox(agent: string, file: string, content = "DATA") {
  const base = mkdtempSync(join(tmpdir(), "pub-outbox-"))
  mkdirSync(join(base, agent), { recursive: true })
  writeFileSync(join(base, agent, file), content)
  return base
}
function spyIo() {
  const calls: { mkdir: string[]; writeFile: { p: string; data: string }[]; rename: [string, string][] } = { mkdir: [], writeFile: [], rename: [] }
  const io: PublishIO = {
    mkdir: (d) => calls.mkdir.push(d),
    writeFile: (p, data) => calls.writeFile.push({ p, data: data.toString() }),
    rename: (f, t) => calls.rename.push([f, t]),
  }
  return { io, calls }
}
const opts = (over: Partial<PublishOpts> = {}): PublishOpts => ({
  artifactsDir: "/art", raHost: "ra.example", agent: "ada", outboxBase: "/x",
  maxBytes: 1_000_000, defaultTtlDays: 30, now: new Date("2026-06-28T00:00:00Z"),
  randomToken: () => "TOKEN123456789012345", ...over,
})

test("publishArtifact: writes file + .sbmd to a tmp dir, renames atomically, returns the URL", () => {
  const base = outbox("ada", "report.pdf")
  const { io, calls } = spyIo()
  const r = publishArtifact({ path: "report.pdf" }, opts({ outboxBase: base }), io)
  expect(r).toEqual({ ok: true, url: "https://ra.example/share/TOKEN123456789012345", token: "TOKEN123456789012345" })
  // atomic: mkdir <token>.tmp, write both files into it, then rename .tmp → <token>
  expect(calls.mkdir).toEqual([join("/art", "TOKEN123456789012345.tmp")])
  expect(calls.writeFile.map((w) => w.p)).toEqual([join("/art", "TOKEN123456789012345.tmp", "report.pdf"), join("/art", "TOKEN123456789012345.tmp", "meta.sbmd")])
  expect(calls.rename).toEqual([[join("/art", "TOKEN123456789012345.tmp"), join("/art", "TOKEN123456789012345")]])
  // .sbmd content
  const sbmd = JSON.parse(calls.writeFile[1].data)
  expect(sbmd).toMatchObject({ v: 1, mode: "view", contentType: "application/pdf", filename: "report.pdf", title: "report.pdf", scope: "staff", producer: "agent:ada", createdAt: "2026-06-28T00:00:00.000Z", expiresAt: "2026-07-28T00:00:00.000Z" })
})

test("publishArtifact: explicit mode/title/scope/ttl override the defaults", () => {
  const base = outbox("ada", "data.csv")
  const { io, calls } = spyIo()
  const r = publishArtifact({ path: "data.csv", mode: "download", title: "Q2 export", scope: "finance.read", ttlDays: 7 }, opts({ outboxBase: base }), io)
  expect(r.ok).toBe(true)
  const sbmd = JSON.parse(calls.writeFile[1].data)
  expect(sbmd).toMatchObject({ mode: "download", title: "Q2 export", scope: "finance.read", contentType: "text/csv", expiresAt: "2026-07-05T00:00:00.000Z" })
})

test("publishArtifact: an outbox escape is rejected with the reason, nothing written", () => {
  const base = outbox("ada", "report.pdf")
  const { io, calls } = spyIo()
  const r = publishArtifact({ path: "../secret" }, opts({ outboxBase: base }), io)
  expect(r).toEqual({ ok: false, reason: "escape" })
  expect(calls.writeFile).toEqual([])
  expect(calls.rename).toEqual([])
})

test("publishArtifact: an invalid explicit mode falls back to the inferred mode", () => {
  const base = outbox("ada", "report.pdf")
  const { io, calls } = spyIo()
  publishArtifact({ path: "report.pdf", mode: "bogus" }, opts({ outboxBase: base }), io)
  expect(JSON.parse(calls.writeFile[1].data).mode).toBe("view")
})
