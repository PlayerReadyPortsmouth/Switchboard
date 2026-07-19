/** Humanizing identities for the Discord-side copy of mirrored web messages.
 *
 *  Web participants are identified by their Entra email, which is what the
 *  canonical `Message.author` carries. Rendering that raw into a busy Discord
 *  channel is long and ugly (`**Aurora.Nicholas@player-ready.co.uk** · …`), so
 *  the mirror renders a short human name instead.
 *
 *  Only *display* is affected: `author` is untouched in the store, and message
 *  identity on the Discord side is the Discord message id (see
 *  `external_message_links`), never the rendered text — so changing this
 *  formatting cannot cause a mirrored message to be re-ingested. */

/** Marker for a message that originated in the web workspace. A standard
 *  Unicode emoji, not a custom guild emoji, so it renders for every viewer,
 *  and it carries no markdown syntax of its own to interact with Discord's
 *  parser. */
export const WEB_ORIGIN_MARKER = "🌐"

const SEPARATORS = /[._-]+/

/** Title-case a name segment, but leave deliberate inner capitals alone.
 *  Most prod emails are all-lowercase (`aurora.nicholas@…`), a handful are
 *  mixed (`Aurora.Nicholas@…`); both must render as `Aurora`. A segment that
 *  already mixes case (`McDonald`) is assumed intentional and kept as-is. */
function titleCase(segment: string): string {
  const uniform = segment === segment.toLowerCase() || segment === segment.toUpperCase()
  const rest = uniform ? segment.slice(1).toLowerCase() : segment.slice(1)
  return segment.charAt(0).toUpperCase() + rest
}

/** `Firstname.Surname@domain` → `Firstname S.`
 *
 *  Anything that isn't a plain single-`@` email address is passed through
 *  untouched — agent names (`dev-agent`), Discord identities
 *  (`discord:186188409499418628`), and malformed or empty input. A local part
 *  with no separator yields just the capitalised name; no surname is invented.
 *  Never throws: an identity it can't parse is returned as it arrived. */
export function humanizeIdentity(identity: string): string {
  if (typeof identity !== "string" || !identity) return identity ?? ""
  const at = identity.indexOf("@")
  // Require exactly one "@", with a non-empty local part and domain.
  if (at <= 0 || at !== identity.lastIndexOf("@") || at === identity.length - 1) return identity

  const segments = identity.slice(0, at).split(SEPARATORS).filter(Boolean)
  if (segments.length === 0) return identity
  if (segments.length === 1) return titleCase(segments[0]!)

  // More than two segments: first name plus the initial of the last segment,
  // which is the surname for every real shape we see.
  const first = titleCase(segments[0]!)
  return `${first} ${segments[segments.length - 1]!.charAt(0).toUpperCase()}.`
}

/** The Discord-side line for a message that came from the web workspace.
 *  Content is passed through verbatim — only the prefix is ours. */
export function formatWebMirrorLine(author: string, content: string): string {
  return `${WEB_ORIGIN_MARKER} **${humanizeIdentity(author)}** · ${content}`
}
