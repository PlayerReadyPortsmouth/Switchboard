/** Opt-in "only respond when addressed" gate for guild channels.
 *  A message counts as addressed to the bot when the bot is @mentioned, the
 *  message replies to one of the bot's own messages, or one of `keywords`
 *  matches the content (case-insensitive, whole-word). DMs are always direct
 *  address and bypass this gate at the call site. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** True when the message explicitly addresses the bot. `mentioned` and
 *  `repliedToBot` are resolved by the caller from the Discord message; keyword
 *  matching is whole-word and case-insensitive so "Ops" hits "ops?" but not
 *  "Operations" or "stops". Empty/absent keywords ⇒ only mention/reply count. */
export function isAddressed(
  content: string,
  mentioned: boolean,
  repliedToBot: boolean,
  keywords: string[] = [],
): boolean {
  if (mentioned || repliedToBot) return true
  return keywords.some(w => w.length > 0 && new RegExp(`\\b${escapeRegExp(w)}\\b`, "i").test(content))
}
