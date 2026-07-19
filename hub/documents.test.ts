// hub/documents.test.ts
import { test, expect } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { runDocumentsMigrations } from "./documentsMigrations"
import {
  DocumentsDb, publishDocument, uploadDocument, setVisibility, deleteDocument, listDocuments,
  rowFromSbmd, listConversationDocuments, type DocumentRow, type DocumentsIO, type DocumentsOpts,
} from "./documents"

function fakeIo() {
  const files = new Map<string, string>()
  const io: DocumentsIO = {
    mkdir: () => {},
    writeFile: (p, data) => { files.set(p, data.toString()) },
    rename: (from, to) => {
      for (const [k, v] of [...files]) {
        if (k === from || k.startsWith(from + "/")) { files.set(to + k.slice(from.length), v); files.delete(k) }
      }
    },
    readFile: (p) => { const v = files.get(p); if (v === undefined) throw new Error("ENOENT"); return v },
    rm: (dir) => { for (const k of [...files.keys()]) if (k === dir || k.startsWith(dir + "/")) files.delete(k) },
  }
  return { io, files }
}

function setup() {
  const db = new Database(":memory:")
  runDocumentsMigrations(db)
  const { io, files } = fakeIo()
  const opts: DocumentsOpts = {
    db: new DocumentsDb(db), io,
    artifactsDir: "/art", raHost: "ra.example", agent: "ada", outboxBase: "/x",
    maxBytes: 1_000_000, defaultTtlDays: 30, now: new Date("2026-07-18T00:00:00Z"),
    randomToken: (() => { let n = 0; return () => `TOKEN${(++n).toString().padStart(15, "0")}` })(),
  }
  return { db, opts, files }
}

function outboxWith(file: string, content = "DATA") {
  const base = mkdtempSync(join(tmpdir(), "doc-outbox-"))
  mkdirSync(join(base, "ada"), { recursive: true })
  writeFileSync(join(base, "ada", file), content)
  return base
}

test("publishDocument (no ttl) writes a permanent sbmd + inserts a mirror row", async () => {
  const { opts, files } = setup()
  opts.outboxBase = outboxWith("report.pdf")
  const r = await publishDocument({ path: "report.pdf", ownerId: "ada@ready.co", ownerName: "Ada" }, opts)
  expect(r.ok).toBe(true)
  if (!r.ok) return
  const sbmd = JSON.parse(files.get(join("/art", r.token, "meta.sbmd"))!)
  expect(sbmd.expiresAt).toBe("")           // permanent
  expect(sbmd.visibility).toBe("private")   // default
  const row = opts.db.get(r.token)!
  expect(row.ownerId).toBe("ada@ready.co")
  expect(row.visibility).toBe("private")
  expect(row.expiresAt).toBeNull()
})

test("publishDocument with an explicit ttl_days stays ephemeral", async () => {
  const { opts, files } = setup()
  opts.outboxBase = outboxWith("report.pdf")
  const r = await publishDocument({ path: "report.pdf", ttlDays: 7, ownerId: "ada@ready.co", ownerName: "Ada" }, opts)
  expect(r.ok).toBe(true)
  if (!r.ok) return
  const sbmd = JSON.parse(files.get(join("/art", r.token, "meta.sbmd"))!)
  expect(sbmd.expiresAt).not.toBe("")
  expect(opts.db.get(r.token)!.expiresAt).not.toBeNull()
})

test("publishDocument without an owner (Discord) reconciles to the org-visible 'discord' bucket", async () => {
  const { opts, files } = setup()
  opts.outboxBase = outboxWith("report.pdf")
  const r = await publishDocument({ path: "report.pdf" }, opts)
  expect(r.ok).toBe(true)
  if (!r.ok) return
  const sbmd = JSON.parse(files.get(join("/art", r.token, "meta.sbmd"))!)
  expect(sbmd.ownerId).toBeUndefined()
  expect(sbmd.visibility).toBeUndefined()   // left visibility-less on disk
  const row = opts.db.get(r.token)!
  expect(row.ownerId).toBe("discord")
  expect(row.visibility).toBe("org")
})

test("uploadDocument writes bytes + inserts a row; oversize is rejected", async () => {
  const { opts, files } = setup()
  const r = await uploadDocument(
    { filename: "photo.png", bytes: Buffer.from("PNGDATA"), ownerId: "bob@ready.co", ownerName: "Bob" }, opts)
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(files.get(join("/art", r.token, "photo.png"))).toBe("PNGDATA")
  expect(opts.db.get(r.token)!.contentType).toBe("image/png")

  const big = await uploadDocument(
    { filename: "big.bin", bytes: Buffer.alloc(opts.maxBytes + 1), ownerId: "bob@ready.co", ownerName: "Bob" }, opts)
  expect(big).toEqual({ ok: false, reason: "oversize" })
})

test("listDocuments: mine filters by owner, org filters by visibility", async () => {
  const { opts } = setup()
  opts.db.upsert(rowFromSbmd("t-priv", {
    v: 1, mode: "download", contentType: "text/plain", filename: "a.txt", title: "A", scope: "staff",
    createdAt: "2026-07-01T00:00:00Z", expiresAt: "", producer: "upload",
    ownerId: "ada@ready.co", ownerName: "Ada", visibility: "private",
  }, 3, null))
  opts.db.upsert(rowFromSbmd("t-org", {
    v: 1, mode: "download", contentType: "text/plain", filename: "b.txt", title: "B", scope: "staff",
    createdAt: "2026-07-02T00:00:00Z", expiresAt: "", producer: "upload",
    ownerId: "ada@ready.co", ownerName: "Ada", visibility: "org",
  }, 3, null))
  // Discord-originated (no owner/visibility in sbmd)
  opts.db.upsert(rowFromSbmd("t-discord", {
    v: 1, mode: "download", contentType: "application/pdf", filename: "c.pdf", title: "C", scope: "staff",
    createdAt: "2026-07-03T00:00:00Z", expiresAt: "", producer: "agent:zed",
  }, 5, null))

  const mine = listDocuments({ requesterId: "ada@ready.co", scope: "mine" }, opts).map((d) => d.token)
  expect(mine.sort()).toEqual(["t-org", "t-priv"])   // both ada-owned, discord excluded
  const org = listDocuments({ requesterId: "ada@ready.co", scope: "org" }, opts).map((d) => d.token)
  expect(org.sort()).toEqual(["t-discord", "t-org"]) // org-visible incl discord, private excluded
})

test("setVisibility: owner can toggle (disk + row updated); non-owner and discord rejected", async () => {
  const { opts, files } = setup()
  const r = await uploadDocument(
    { filename: "n.txt", bytes: Buffer.from("x"), ownerId: "ada@ready.co", ownerName: "Ada" }, opts)
  expect(r.ok).toBe(true)
  if (!r.ok) return

  expect(await setVisibility(r.token, "org", "someone@else.co", opts)).toEqual({ ok: false, reason: "not_owner" })
  expect(await setVisibility(r.token, "org", "ada@ready.co", opts)).toEqual({ ok: true })
  expect(opts.db.get(r.token)!.visibility).toBe("org")
  const sbmd = JSON.parse(files.get(join("/art", r.token, "meta.sbmd"))!)
  expect(sbmd.visibility).toBe("org")   // disk (authoritative) updated too

  opts.db.upsert(rowFromSbmd("t-discord", {
    v: 1, mode: "view", contentType: "application/pdf", filename: "d.pdf", title: "D", scope: "staff",
    createdAt: "2026-07-03T00:00:00Z", expiresAt: "", producer: "agent:zed",
  }, 5, null))
  expect(await setVisibility("t-discord", "private", "anyone@ready.co", opts)).toEqual({ ok: false, reason: "not_owner" })
})

test("deleteDocument: owner removes fs + row; non-owner and discord rejected", async () => {
  const { opts, files } = setup()
  const r = await uploadDocument(
    { filename: "n.txt", bytes: Buffer.from("x"), ownerId: "ada@ready.co", ownerName: "Ada" }, opts)
  expect(r.ok).toBe(true)
  if (!r.ok) return

  expect(await deleteDocument(r.token, "someone@else.co", opts)).toEqual({ ok: false, reason: "not_owner" })
  expect(await deleteDocument(r.token, "ada@ready.co", opts)).toEqual({ ok: true })
  expect(opts.db.get(r.token)).toBeNull()
  expect(files.get(join("/art", r.token, "meta.sbmd"))).toBeUndefined()

  opts.db.upsert(rowFromSbmd("t-discord", {
    v: 1, mode: "view", contentType: "application/pdf", filename: "d.pdf", title: "D", scope: "staff",
    createdAt: "2026-07-03T00:00:00Z", expiresAt: "", producer: "agent:zed",
  }, 5, null))
  expect(await deleteDocument("t-discord", "anyone@ready.co", opts)).toEqual({ ok: false, reason: "not_owner" })
})

// --- Conversation-scoped listing (transcript attachment hydration) -------------------
// Deliberately driven through `DocumentsDb`/`listConversationDocuments` with rows inserted
// directly: this path never touches the filesystem, so these tests are free of the path
// separator assumption that makes the fs-backed tests above fail on Windows.

const conversationRow = (over: Partial<DocumentRow> = {}): DocumentRow => ({
  token: "t1", filename: "notes.md", title: "notes.md", contentType: "text/markdown", mode: "view",
  ownerId: "ada@ready.co", ownerName: "Ada", visibility: "org", createdAt: "2026-07-19T10:00:00.000Z",
  expiresAt: null, conversationId: "conv-1", sizeBytes: 128, ...over,
})

test("listConversationDocuments returns a conversation's org documents to any staff identity", () => {
  const { opts } = setup()
  opts.db.upsert(conversationRow())
  const rows = listConversationDocuments("conv-1", "someone@else.co", opts)
  expect(rows.map(r => r.token)).toEqual(["t1"])
  // size_bytes must survive the round trip — the card renders a size only when it is supplied.
  expect(rows[0]!.sizeBytes).toBe(128)
})

test("listConversationDocuments EXCLUDES a private document owned by someone else, and includes the requester's own", () => {
  const { opts } = setup()
  opts.db.upsert(conversationRow({ token: "mine", visibility: "private", ownerId: "ada@ready.co" }))
  opts.db.upsert(conversationRow({ token: "theirs", visibility: "private", ownerId: "bob@ready.co" }))
  opts.db.upsert(conversationRow({ token: "shared", visibility: "org", ownerId: "bob@ready.co" }))

  // Ada sees her own private row and the org row — never Bob's private one.
  expect(listConversationDocuments("conv-1", "ada@ready.co", opts).map(r => r.token).sort())
    .toEqual(["mine", "shared"])
  expect(listConversationDocuments("conv-1", "bob@ready.co", opts).map(r => r.token).sort())
    .toEqual(["shared", "theirs"])
  // A third party gets the org row only.
  expect(listConversationDocuments("conv-1", "eve@ready.co", opts).map(r => r.token))
    .toEqual(["shared"])
})

test("listConversationDocuments does not leak documents from another conversation", () => {
  const { opts } = setup()
  opts.db.upsert(conversationRow({ token: "here", conversationId: "conv-1" }))
  opts.db.upsert(conversationRow({ token: "elsewhere", conversationId: "conv-2" }))
  opts.db.upsert(conversationRow({ token: "unattached", conversationId: null }))
  expect(listConversationDocuments("conv-1", "ada@ready.co", opts).map(r => r.token)).toEqual(["here"])
})

test("listConversationDocuments orders oldest-first so cards anchor in publish order", () => {
  const { opts } = setup()
  opts.db.upsert(conversationRow({ token: "second", createdAt: "2026-07-19T11:00:00.000Z" }))
  opts.db.upsert(conversationRow({ token: "first", createdAt: "2026-07-19T09:00:00.000Z" }))
  expect(listConversationDocuments("conv-1", "ada@ready.co", opts).map(r => r.token)).toEqual(["first", "second"])
})
