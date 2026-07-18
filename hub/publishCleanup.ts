// hub/publishCleanup.ts
import type { DocumentsDb, DocumentRow } from "./documents"
import { rowFromSbmd } from "./documents"
import type { Sbmd } from "./publishLink"

/** Tokens to remove: those whose `.sbmd` expiresAt is past, plus dirs whose
 *  `.sbmd` was unreadable (no expiresAt) and that are older than `graceMs`
 *  (abandoned mid-write or corrupt). An empty-string expiresAt marks a permanent
 *  document and is never reaped. Pure. */
export function selectExpired(
  entries: { token: string; expiresAt?: string; ageMs?: number }[],
  now: Date,
  graceMs: number,
): string[] {
  const out: string[] = []
  for (const e of entries) {
    if (e.expiresAt === "") continue   // permanent document — never expires
    if (e.expiresAt) {
      const t = Date.parse(e.expiresAt)
      if (Number.isFinite(t) && now.getTime() > t) out.push(e.token)
    } else if (typeof e.ageMs === "number" && e.ageMs > graceMs) {
      out.push(e.token)
    }
  }
  return out
}

/** Compare the mirror-relevant fields of a row against a freshly-derived one (conversationId
 *  lives only in the DB, never on disk, so it is excluded from the comparison). */
function rowDiffers(a: DocumentRow, b: DocumentRow): boolean {
  return a.filename !== b.filename || a.title !== b.title || a.contentType !== b.contentType
    || a.mode !== b.mode || a.ownerId !== b.ownerId || a.ownerName !== b.ownerName
    || a.visibility !== b.visibility || a.createdAt !== b.createdAt
    || a.expiresAt !== b.expiresAt || a.sizeBytes !== b.sizeBytes
}

/** Reconcile the SQLite `documents` mirror against the authoritative on-disk `.sbmd` set:
 *  insert rows for dirs missing one, delete rows for dirs that no longer exist, and overwrite
 *  rows whose fields drifted from disk. `conversationId` on an existing row is preserved (it is
 *  not recoverable from disk). Pure aside from the injected `db`. */
export function reconcileDocuments(
  diskEntries: { token: string; sbmd: Sbmd; sizeBytes: number }[],
  db: DocumentsDb,
): { inserted: number; updated: number; deleted: number } {
  let inserted = 0, updated = 0, deleted = 0
  const onDisk = new Set(diskEntries.map((e) => e.token))

  for (const e of diskEntries) {
    const existing = db.get(e.token)
    const next = rowFromSbmd(e.token, e.sbmd, e.sizeBytes, existing?.conversationId ?? null)
    if (!existing) { db.upsert(next); inserted++ }
    else if (rowDiffers(existing, next)) { db.upsert(next); updated++ }
  }
  for (const token of db.allTokens()) {
    if (!onDisk.has(token)) { db.delete(token); deleted++ }
  }
  return { inserted, updated, deleted }
}
