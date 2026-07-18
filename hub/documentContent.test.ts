// hub/documentContent.test.ts — the read path behind GET /api/documents/:token/content.
import { test, expect } from "bun:test"
import { Database } from "bun:sqlite"
import { runDocumentsMigrations } from "./documentsMigrations"
import { DocumentsDb, readDocumentContent, rowFromSbmd, type DocumentReadOpts } from "./documents"
import type { Sbmd } from "./publishLink"

const sbmd = (overrides: Partial<Sbmd> = {}): Sbmd => ({
  v: 1, mode: "view", contentType: "text/markdown", filename: "notes.md", title: "Notes",
  scope: "staff", createdAt: "2026-07-18T00:00:00Z", expiresAt: "", producer: "upload",
  ownerId: "ada@example.com", ownerName: "Ada", visibility: "private", ...overrides,
})

function setup(files: Record<string, string> = {}) {
  const database = new Database(":memory:")
  runDocumentsMigrations(database)
  const db = new DocumentsDb(database)
  const opts: DocumentReadOpts = {
    db,
    artifactsDir: "/art",
    io: {
      readBytes: (p) => {
        const normalised = p.replaceAll("\\", "/")
        const value = files[normalised]
        if (value === undefined) throw new Error("ENOENT")
        return Buffer.from(value)
      },
    },
  }
  return { db, opts }
}

test("the owner can read their own private document", () => {
  const { db, opts } = setup({ "/art/TOK/notes.md": "# hello" })
  db.upsert(rowFromSbmd("TOK", sbmd(), 7, null))
  const result = readDocumentContent("TOK", "ada@example.com", opts)
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.bytes.toString()).toBe("# hello")
  expect(result.row.contentType).toBe("text/markdown")
})

test("a non-owner is refused a private document", () => {
  const { db, opts } = setup({ "/art/TOK/notes.md": "# hello" })
  db.upsert(rowFromSbmd("TOK", sbmd(), 7, null))
  expect(readDocumentContent("TOK", "bob@example.com", opts)).toEqual({ ok: false, reason: "forbidden" })
})

test("an org-visible document is readable by any identity", () => {
  const { db, opts } = setup({ "/art/TOK/notes.md": "shared" })
  db.upsert(rowFromSbmd("TOK", sbmd({ visibility: "org" }), 6, null))
  const result = readDocumentContent("TOK", "bob@example.com", opts)
  expect(result.ok).toBe(true)
})

test("a Discord-originated artifact reconciles to org and stays readable", () => {
  const { db, opts } = setup({ "/art/TOK/notes.md": "from discord" })
  const row = rowFromSbmd("TOK", sbmd({ ownerId: undefined, ownerName: undefined, visibility: undefined }), 12, null)
  expect(row.visibility).toBe("org")
  db.upsert(row)
  expect(readDocumentContent("TOK", "bob@example.com", opts).ok).toBe(true)
})

test("an unknown token is not found", () => {
  const { opts } = setup()
  expect(readDocumentContent("NOPE", "ada@example.com", opts)).toEqual({ ok: false, reason: "not_found" })
})

test("a mirror row whose artifact is gone reports read_failed, not a crash", () => {
  const { db, opts } = setup()
  db.upsert(rowFromSbmd("TOK", sbmd(), 7, null))
  expect(readDocumentContent("TOK", "ada@example.com", opts)).toEqual({ ok: false, reason: "read_failed" })
})

test("visibility is checked before disk, so a missing private artifact still refuses non-owners", () => {
  const { db, opts } = setup()
  db.upsert(rowFromSbmd("TOK", sbmd(), 7, null))
  expect(readDocumentContent("TOK", "bob@example.com", opts)).toEqual({ ok: false, reason: "forbidden" })
})
