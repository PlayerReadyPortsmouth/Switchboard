// hub/webIdentity.ts
// The single bridge between a web identity and a Discord snowflake.
//
// Every authorisation gate in the hub is keyed on a Discord user id. A web caller
// presents an email (the value of the trusted identity header). Rather than write a
// parallel set of web authorisation rules — which drift from the Discord ones — a web
// click resolves its email to a snowflake HERE and then runs the existing gates
// unchanged (hub/cardGate.ts, baseGate).
//
// Fail closed: an email with no mapping resolves to `undefined` and the caller MUST
// reject. There is no fallback, no "treat the email as an id", and nothing hardcoded —
// the map comes entirely from hub.webCards.identityMap.

/** Build a lookup from the configured map. Keys are normalised (trimmed, lowercased) so
 *  a header that differs only in case or padding still matches; VALUES are used verbatim,
 *  because a snowflake is exact and silently rewriting one would be a security bug.
 *
 *  A blank key or blank value is dropped rather than stored: an entry mapping "" to a
 *  snowflake would grant that snowflake's rights to any caller whose header normalises
 *  to empty. */
export function buildIdentityMap(configured: Record<string, string> | undefined): Map<string, string> {
  const map = new Map<string, string>()
  for (const [email, userId] of Object.entries(configured ?? {})) {
    const key = normalizeIdentity(email)
    const value = typeof userId === "string" ? userId.trim() : ""
    if (!key || !value) continue
    map.set(key, value)
  }
  return map
}

export function normalizeIdentity(identity: string | null | undefined): string {
  return (identity ?? "").trim().toLowerCase()
}

/** Resolve a web identity to the Discord snowflake the gates expect, or `undefined`
 *  when the identity is unknown. Callers must treat `undefined` as a rejection. */
export function resolveDiscordId(identity: string | null | undefined, map: Map<string, string>): string | undefined {
  const key = normalizeIdentity(identity)
  if (!key) return undefined
  return map.get(key)
}
