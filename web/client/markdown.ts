// A deliberately small CommonMark subset, parsed to a data structure that `<Markdown>` turns
// into React elements. Nothing here ever produces HTML strings: the ReadyApp `/share` renderer
// can hand `marked` output to the browser because it serves into a sandboxed document, but the
// workspace renders documents on its own origin, so the only safe shape is elements we build
// ourselves. Injected markup therefore stays inert text, and URLs are scheme-allowlisted.

export type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "code"; language: string; text: string }
  | { kind: "quote"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "table"; header: string[]; rows: string[][] }
  | { kind: "rule" }

export type Inline =
  | { kind: "text"; value: string }
  | { kind: "code"; value: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] }
  | { kind: "del"; children: Inline[] }
  | { kind: "link"; href: string; children: Inline[] }
  | { kind: "image"; href: string; alt: string }

const HEADING = /^(#{1,6})\s+(.*)$/
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/
const ORDERED = /^\s{0,3}\d+[.)]\s+(.*)$/
const QUOTE = /^\s{0,3}>\s?(.*)$/
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/
const FENCE = /^\s{0,3}(?:```|~~~)\s*([\w+-]*)\s*$/
const TABLE_DIVIDER = /^\s*\|?(?:\s*:?-+:?\s*\|)+\s*:?-*:?\s*\|?\s*$/

const startsBlock = (line: string): boolean =>
  HEADING.test(line) || BULLET.test(line) || ORDERED.test(line) ||
  QUOTE.test(line) || RULE.test(line) || FENCE.test(line)

const tableCells = (row: string): string[] =>
  row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(cell => cell.trim())

export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n")
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }

    const fence = FENCE.exec(line)
    if (fence) {
      const body: string[] = []
      i++
      while (i < lines.length && !FENCE.test(lines[i])) body.push(lines[i++])
      if (i < lines.length) i++   // consume the closing fence; an unclosed fence just ends at EOF
      blocks.push({ kind: "code", language: fence[1] ?? "", text: body.join("\n") })
      continue
    }

    if (RULE.test(line)) { blocks.push({ kind: "rule" }); i++; continue }

    const heading = HEADING.exec(line)
    if (heading) { blocks.push({ kind: "heading", level: heading[1].length, text: heading[2].trim() }); i++; continue }

    if (QUOTE.test(line)) {
      const body: string[] = []
      while (i < lines.length && QUOTE.test(lines[i])) body.push(QUOTE.exec(lines[i++])![1])
      blocks.push({ kind: "quote", text: body.join(" ").trim() })
      continue
    }

    if (BULLET.test(line) || ORDERED.test(line)) {
      const ordered = !BULLET.test(line)
      const items: string[] = []
      for (let match = ordered ? ORDERED.exec(lines[i]) : BULLET.exec(lines[i]); match;) {
        items.push(match[1].trim())
        i++
        match = i < lines.length ? (ordered ? ORDERED.exec(lines[i]) : BULLET.exec(lines[i])) : null
      }
      blocks.push({ kind: "list", ordered, items })
      continue
    }

    if (line.includes("|") && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1])) {
      const header = tableCells(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i].trim() && lines[i].includes("|")) rows.push(tableCells(lines[i++]))
      blocks.push({ kind: "table", header, rows })
      continue
    }

    const body: string[] = []
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) body.push(lines[i++])
    blocks.push({ kind: "paragraph", text: body.join("\n").trim() })
  }
  return blocks
}

// One alternation over every inline form. `\k<…>` backreferences keep the closing delimiter
// matched to the opening one, so `**bold**` cannot be closed by a stray `__`.
const INLINE_SOURCE =
  "(?<ticks>`+)(?<code>[\\s\\S]*?)\\k<ticks>" +
  "|!\\[(?<imgAlt>[^\\]]*)\\]\\((?<imgHref>[^)\\s]*)\\)" +
  "|\\[(?<linkText>[^\\]]*)\\]\\((?<linkHref>[^)\\s]*)\\)" +
  "|(?<strongMark>\\*\\*|__)(?<strong>[\\s\\S]+?)\\k<strongMark>" +
  "|(?<emMark>[*_])(?<em>[^\\s*_][\\s\\S]*?)\\k<emMark>" +
  "|~~(?<del>[\\s\\S]+?)~~" +
  "|(?<auto>https?:\\/\\/[^\\s<>)\\]]+)"

const MAX_INLINE_DEPTH = 6

export function parseInline(text: string, depth = 0): Inline[] {
  if (depth >= MAX_INLINE_DEPTH) return text ? [{ kind: "text", value: text }] : []
  // A fresh regex per call: `lastIndex` is per-instance state and this function recurses.
  const pattern = new RegExp(INLINE_SOURCE, "g")
  const nodes: Inline[] = []
  let last = 0
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (match.index > last) nodes.push({ kind: "text", value: text.slice(last, match.index) })
    const groups = match.groups ?? {}
    if (groups.code !== undefined) nodes.push({ kind: "code", value: groups.code })
    else if (groups.imgHref !== undefined) nodes.push({ kind: "image", href: groups.imgHref, alt: groups.imgAlt ?? "" })
    else if (groups.linkHref !== undefined) nodes.push({ kind: "link", href: groups.linkHref, children: parseInline(groups.linkText ?? "", depth + 1) })
    else if (groups.strong !== undefined) nodes.push({ kind: "strong", children: parseInline(groups.strong, depth + 1) })
    else if (groups.em !== undefined) nodes.push({ kind: "em", children: parseInline(groups.em, depth + 1) })
    else if (groups.del !== undefined) nodes.push({ kind: "del", children: parseInline(groups.del, depth + 1) })
    else if (groups.auto !== undefined) nodes.push({ kind: "link", href: groups.auto, children: [{ kind: "text", value: groups.auto }] })
    last = match.index + match[0].length
  }
  if (last < text.length) nodes.push({ kind: "text", value: text.slice(last) })
  return nodes
}

/** Scheme allowlist for every `href`/`src` the renderer emits. Anything that is not plainly
 *  http(s)/mailto, or a same-origin relative path, is dropped — this is what keeps
 *  `javascript:` and `data:` payloads out of the rendered document. */
export function safeUrl(raw: string): string | null {
  const value = raw.trim()
  if (!value) return null
  if (value.startsWith("//")) return null          // protocol-relative: resolves off-origin
  if (value.startsWith("/") || value.startsWith("#")) return value
  return /^(?:https?:\/\/|mailto:)/i.test(value) ? value : null
}
