// hub/publishCleanup.ts
/** Tokens to remove: those whose `.sbmd` expiresAt is past, plus dirs whose
 *  `.sbmd` was unreadable (no expiresAt) and that are older than `graceMs`
 *  (abandoned mid-write or corrupt). Pure. */
export function selectExpired(
  entries: { token: string; expiresAt?: string; ageMs?: number }[],
  now: Date,
  graceMs: number,
): string[] {
  const out: string[] = []
  for (const e of entries) {
    if (e.expiresAt) {
      const t = Date.parse(e.expiresAt)
      if (Number.isFinite(t) && now.getTime() > t) out.push(e.token)
    } else if (typeof e.ageMs === "number" && e.ageMs > graceMs) {
      out.push(e.token)
    }
  }
  return out
}
