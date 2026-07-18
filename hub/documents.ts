// hub/documents.ts
// The Documents library: permanent, ownable, visibility-scoped artifacts layered on top of
// the existing share-link pipeline. The on-disk `.sbmd` set under ARTIFACTS_DIR is the source
// of truth; the SQLite `documents` table (see documentsMigrations.ts) is a queryable MIRROR,
// reconciled from disk by the cleanup sweep. Injectable IO throughout, mirroring publishLink.ts.
import type { Database } from "bun:sqlite"
import { join } from "path"
import {
  publishArtifact, inferModeAndType,
  type PublishArgs, type PublishOpts, type PublishIO, type PublishResult, type Sbmd,
} from "./publishLink"

export interface DocumentRow {
  token: string
  filename: string
  title: string
  contentType: string
  mode: string
  ownerId: string
  ownerName: string
  visibility: "private" | "org"
  createdAt: string
  expiresAt: string | null
  conversationId: string | null
  sizeBytes: number
}

/** IO used by the document write/delete paths — a superset of PublishIO. */
export interface DocumentsIO extends PublishIO {
  readFile: (p: string) => string
  rm: (dir: string) => void
}

export interface DocumentsOpts extends PublishOpts { db: DocumentsDb; io: DocumentsIO }

type Snake = {
  token: string; filename: string; title: string; content_type: string; mode: string
  owner_id: string; owner_name: string; visibility: string; created_at: string
  expires_at: string | null; conversation_id: string | null; size_bytes: number
}
const toRow = (r: Snake): DocumentRow => ({
  token: r.token, filename: r.filename, title: r.title, contentType: r.content_type, mode: r.mode,
  ownerId: r.owner_id, ownerName: r.owner_name, visibility: r.visibility as "private" | "org",
  createdAt: r.created_at, expiresAt: r.expires_at, conversationId: r.conversation_id, sizeBytes: r.size_bytes,
})

/** Thin typed wrapper over the `documents` table. Pure SQLite — no fs. */
export class DocumentsDb {
  constructor(private readonly db: Database) {}

  upsert(row: DocumentRow): void {
    this.db.query(`INSERT OR REPLACE INTO documents
      (token, filename, title, content_type, mode, owner_id, owner_name, visibility,
       created_at, expires_at, conversation_id, size_bytes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      row.token, row.filename, row.title, row.contentType, row.mode, row.ownerId, row.ownerName,
      row.visibility, row.createdAt, row.expiresAt, row.conversationId, row.sizeBytes)
  }

  get(token: string): DocumentRow | null {
    const r = this.db.query<Snake, [string]>("SELECT * FROM documents WHERE token = ?").get(token)
    return r ? toRow(r) : null
  }

  list(requesterId: string, scope: "mine" | "org"): DocumentRow[] {
    const rows = scope === "mine"
      ? this.db.query<Snake, [string]>(
          "SELECT * FROM documents WHERE owner_id = ? ORDER BY created_at DESC").all(requesterId)
      : this.db.query<Snake, []>(
          "SELECT * FROM documents WHERE visibility = 'org' ORDER BY created_at DESC").all()
    return rows.map(toRow)
  }

  updateVisibility(token: string, visibility: "private" | "org"): void {
    this.db.query("UPDATE documents SET visibility = ? WHERE token = ?").run(visibility, token)
  }

  delete(token: string): void {
    this.db.query("DELETE FROM documents WHERE token = ?").run(token)
  }

  allTokens(): string[] {
    return this.db.query<{ token: string }, []>("SELECT token FROM documents").all().map((r) => r.token)
  }
}

/** Build a mirror row from an on-disk `.sbmd`. Discord-originated artifacts (no ownerId /
 *  visibility) map to owner_id "discord", owner_name "Discord", visibility "org". */
export function rowFromSbmd(token: string, sbmd: Sbmd, sizeBytes: number, conversationId: string | null): DocumentRow {
  return {
    token,
    filename: sbmd.filename,
    title: sbmd.title,
    contentType: sbmd.contentType,
    mode: sbmd.mode,
    ownerId: sbmd.ownerId ?? "discord",
    ownerName: sbmd.ownerName ?? "Discord",
    visibility: sbmd.visibility ?? "org",
    createdAt: sbmd.createdAt,
    expiresAt: sbmd.expiresAt ? sbmd.expiresAt : null,
    conversationId,
    sizeBytes,
  }
}

/** Agent-published document. Omitted ttl_days ⇒ permanent; an explicit positive ttl_days still
 *  produces an ephemeral link. An owned (web-conversation) publish defaults to "private"
 *  visibility; an ownerless (Discord) publish is left visibility-less so `rowFromSbmd`
 *  reconciles it into the org-visible "discord" bucket. */
export async function publishDocument(
  args: PublishArgs & { ownerId?: string; ownerName?: string; visibility?: "private" | "org"; conversationId?: string },
  opts: DocumentsOpts,
): Promise<PublishResult> {
  const permanent = !(typeof args.ttlDays === "number" && args.ttlDays > 0)
  const visibility = args.ownerId ? args.visibility ?? "private" : args.visibility
  const r = publishArtifact({ ...args, permanent, visibility }, opts, opts.io)
  if (r.ok) opts.db.upsert(rowFromSbmd(r.token, r.sbmd, r.sizeBytes, args.conversationId ?? null))
  return r
}

/** Direct human upload (drag-and-drop). Writes straight into ARTIFACTS_DIR — no outbox. */
export async function uploadDocument(
  args: { filename: string; bytes: Buffer; title?: string; visibility?: "private" | "org"; ownerId: string; ownerName: string },
  opts: DocumentsOpts,
): Promise<PublishResult> {
  if (args.bytes.byteLength > opts.maxBytes) return { ok: false, reason: "oversize" }
  const filename = args.filename.replace(/[/\\]/g, "").trim()
  if (!filename || filename === "meta.sbmd") return { ok: false, reason: "bad_filename" }

  const { mode, contentType } = inferModeAndType(filename)
  const token = opts.randomToken()
  const sbmd: Sbmd = {
    v: 1, mode, contentType, filename,
    title: args.title || filename, scope: "staff",
    createdAt: opts.now.toISOString(), expiresAt: "", producer: "upload",
    ownerId: args.ownerId, ownerName: args.ownerName, visibility: args.visibility ?? "private",
  }
  const tmp = join(opts.artifactsDir, `${token}.tmp`)
  const finalDir = join(opts.artifactsDir, token)
  try {
    opts.io.mkdir(tmp)
    opts.io.writeFile(join(tmp, filename), args.bytes)
    opts.io.writeFile(join(tmp, "meta.sbmd"), JSON.stringify(sbmd))
    opts.io.rename(tmp, finalDir)
  } catch { return { ok: false, reason: "write_failed" } }
  opts.db.upsert(rowFromSbmd(token, sbmd, args.bytes.byteLength, null))
  return { ok: true, url: `https://${opts.raHost}/share/${token}`, token, sbmd, sizeBytes: args.bytes.byteLength }
}

/** Owner-only. Updates the on-disk `.sbmd` (authoritative) then the mirror row. */
export async function setVisibility(
  token: string, visibility: "private" | "org", requesterId: string, opts: DocumentsOpts,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const row = opts.db.get(token)
  if (!row) return { ok: false, reason: "not_found" }
  if (row.ownerId === "discord" || row.ownerId !== requesterId) return { ok: false, reason: "not_owner" }

  const metaPath = join(opts.artifactsDir, token, "meta.sbmd")
  let sbmd: Sbmd
  try { sbmd = JSON.parse(opts.io.readFile(metaPath)) as Sbmd } catch { return { ok: false, reason: "not_found" } }
  sbmd.visibility = visibility
  try { opts.io.writeFile(metaPath, JSON.stringify(sbmd)) } catch { return { ok: false, reason: "write_failed" } }
  opts.db.updateVisibility(token, visibility)
  return { ok: true }
}

/** Owner-only. Removes the on-disk artifact directory then the mirror row. */
export async function deleteDocument(
  token: string, requesterId: string, opts: DocumentsOpts,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const row = opts.db.get(token)
  if (!row) return { ok: false, reason: "not_found" }
  if (row.ownerId === "discord" || row.ownerId !== requesterId) return { ok: false, reason: "not_owner" }
  try { opts.io.rm(join(opts.artifactsDir, token)) } catch { return { ok: false, reason: "delete_failed" } }
  opts.db.delete(token)
  return { ok: true }
}

export function listDocuments(
  filter: { requesterId: string; scope: "mine" | "org" }, opts: DocumentsOpts,
): DocumentRow[] {
  return opts.db.list(filter.requesterId, filter.scope)
}

/** IO for the read path. Deliberately separate from `DocumentsIO` (whose `readFile` is utf8-only)
 *  because documents are arbitrary bytes — images and PDFs must not go through a string. */
export interface DocumentReadIO { readBytes: (p: string) => Buffer }
export interface DocumentReadOpts { db: DocumentsDb; artifactsDir: string; io: DocumentReadIO }
export type DocumentContentResult =
  | { ok: true; row: DocumentRow; bytes: Buffer }
  | { ok: false; reason: "not_found" | "forbidden" | "read_failed" }

/** Read a document's bytes for the in-app viewer, under the same visibility contract the
 *  listing enforces: an "org" row is readable by any authenticated staff identity, a "private"
 *  row only by its owner. Visibility is checked before disk is touched, so a private token
 *  never produces a different failure shape depending on whether the artifact still exists. */
export function readDocumentContent(
  token: string, requesterId: string, opts: DocumentReadOpts,
): DocumentContentResult {
  const row = opts.db.get(token)
  if (!row) return { ok: false, reason: "not_found" }
  if (row.visibility !== "org" && row.ownerId !== requesterId) return { ok: false, reason: "forbidden" }
  try {
    return { ok: true, row, bytes: opts.io.readBytes(join(opts.artifactsDir, token, row.filename)) }
  } catch {
    return { ok: false, reason: "read_failed" }
  }
}
