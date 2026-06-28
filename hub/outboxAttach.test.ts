// hub/outboxAttach.test.ts
import { test, expect } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { resolveOutboxFile, type OutboxOpts } from "./outboxAttach"

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "outbox-"))
  const agent = "ada"
  mkdirSync(join(base, agent), { recursive: true })
  const opts: OutboxOpts = { outboxBase: base, agent, maxBytes: 1024, allowedExtensions: [] }
  return { base, agent, opts }
}

// Windows without Developer Mode / admin cannot create symlinks (EPERM). Probe
// once so the symlink-escape test runs on Linux/macOS/CI and skips elsewhere —
// the realpath containment still defends against symlinks regardless.
const SYMLINKS_OK = (() => {
  try {
    const d = mkdtempSync(join(tmpdir(), "slk-"))
    symlinkSync(join(d, "x"), join(d, "y"))
    return true
  } catch { return false }
})()

test("happy path: a file written into the outbox resolves", () => {
  const { base, agent, opts } = fixture()
  writeFileSync(join(base, agent, "report.pdf"), "hello")
  const r = resolveOutboxFile("report.pdf", opts)
  expect(r.ok).toBe(true)
  if (r.ok) { expect(r.filename).toBe("report.pdf"); expect(r.size).toBe(5); expect(r.bytes.toString()).toBe("hello") }
})

test("rejects parent-traversal escaping the outbox", () => {
  const { base, opts } = fixture()
  writeFileSync(join(base, "secret.txt"), "x")        // sibling of the agent dir
  expect(resolveOutboxFile("../secret.txt", opts)).toEqual({ ok: false, reason: "escape" })
})

test.skipIf(!SYMLINKS_OK)("rejects a symlink whose target escapes the outbox", () => {
  const { base, agent, opts } = fixture()
  const secret = join(base, "secret.txt"); writeFileSync(secret, "x")
  symlinkSync(secret, join(base, agent, "link.txt"))
  expect(resolveOutboxFile("link.txt", opts)).toEqual({ ok: false, reason: "escape" })
})

test("a sibling agent dir with a shared prefix is not a false match", () => {
  const { base, agent, opts } = fixture()
  mkdirSync(join(base, agent + "-evil"), { recursive: true })
  writeFileSync(join(base, agent + "-evil", "x.txt"), "x")
  expect(resolveOutboxFile("../" + agent + "-evil/x.txt", opts)).toEqual({ ok: false, reason: "escape" })
})

test("rejects a missing file", () => {
  const { opts } = fixture()
  expect(resolveOutboxFile("nope.pdf", opts)).toEqual({ ok: false, reason: "missing" })
})

test("rejects a directory (not a regular file)", () => {
  const { base, agent, opts } = fixture()
  mkdirSync(join(base, agent, "sub"))
  expect(resolveOutboxFile("sub", opts)).toEqual({ ok: false, reason: "notfile" })
})

test("rejects an oversize file", () => {
  const { base, agent, opts } = fixture()
  writeFileSync(join(base, agent, "big.bin"), "x".repeat(2048))
  expect(resolveOutboxFile("big.bin", opts)).toEqual({ ok: false, reason: "oversize" })
})

test("enforces a non-empty extension allowlist", () => {
  const { base, agent, opts } = fixture()
  writeFileSync(join(base, agent, "a.exe"), "x")
  expect(resolveOutboxFile("a.exe", { ...opts, allowedExtensions: ["md", "pdf"] }))
    .toEqual({ ok: false, reason: "extension" })
})
