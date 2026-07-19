import { Fragment, type JSX, type ReactNode } from "react"
import { parseBlocks, parseInline, safeUrl, type Block, type Inline } from "../markdown"

/** `document` follows CommonMark, where a single newline is just a space between words.
 *  `chat` follows Discord/GFM, where a single newline is a line the author meant to break.
 *  A transcript message is prose someone typed into a box, so collapsing its newlines would
 *  silently reflow every plain multi-line message that contains no markdown at all. */
export type MarkdownVariant = "document" | "chat"

/** Splits a text run on its newlines and rejoins it with real `<br/>` elements. Only ever
 *  called for the `chat` variant; `document` hands the raw string to React unchanged. */
function withHardBreaks(value: string, key: string): ReactNode {
  if (!value.includes("\n")) return value
  const lines = value.split("\n")
  return (
    <Fragment key={key}>
      {lines.map((line, index) => (
        <Fragment key={index}>{index > 0 ? <br /> : null}{line}</Fragment>
      ))}
    </Fragment>
  )
}

function renderInline(nodes: Inline[], keyPrefix: string, variant: MarkdownVariant): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}.${index}`
    switch (node.kind) {
      case "text": return variant === "chat" ? withHardBreaks(node.value, key) : node.value
      case "code": return <code key={key}>{node.value}</code>
      case "strong": return <strong key={key}>{renderInline(node.children, key, variant)}</strong>
      case "em": return <em key={key}>{renderInline(node.children, key, variant)}</em>
      case "del": return <del key={key}>{renderInline(node.children, key, variant)}</del>
      case "image": {
        const src = safeUrl(node.href)
        // A rejected URL degrades to the alt text rather than vanishing, so nothing is silently lost.
        return src ? <img key={key} src={src} alt={node.alt} /> : <span key={key}>{node.alt}</span>
      }
      case "link": {
        const href = safeUrl(node.href)
        return href
          ? <a key={key} href={href} target="_blank" rel="noopener noreferrer nofollow">{renderInline(node.children, key, variant)}</a>
          : <span key={key}>{renderInline(node.children, key, variant)}</span>
      }
    }
  })
}

function renderBlock(block: Block, key: string, variant: MarkdownVariant): ReactNode {
  const inline = (text: string, inlineKey: string) => renderInline(parseInline(text), inlineKey, variant)
  switch (block.kind) {
    case "rule": return <hr key={key} />
    case "code": {
      // The `<pre>` keeps its exact text; the language label lives outside it so that neither
      // the label nor the horizontal scroll of the code affects the other.
      const pre = <pre data-language={block.language || undefined}><code>{block.text}</code></pre>
      if (variant !== "chat") return <div key={key} className="markdown-code">{pre}</div>
      return (
        <div key={key} className="markdown-code">
          {block.language ? <span className="markdown-code-language">{block.language}</span> : null}
          {pre}
        </div>
      )
    }
    case "quote": return <blockquote key={key}>{inline(block.text, key)}</blockquote>
    case "heading": {
      // Shifted one level down for a document: the viewer pane already owns the <h1>. Shifted
      // three for a chat message, which sits inside a transcript rather than owning an outline —
      // a `#` there is emphasis, not a page title, and must not read at document scale.
      const shift = variant === "chat" ? 3 : 1
      const Tag = `h${Math.min(block.level + shift, 6)}` as "h2" | "h3" | "h4" | "h5" | "h6"
      return <Tag key={key}>{inline(block.text, key)}</Tag>
    }
    case "list": return block.ordered
      ? <ol key={key}>{block.items.map((item, index) => <li key={index}>{inline(item, `${key}.${index}`)}</li>)}</ol>
      : <ul key={key}>{block.items.map((item, index) => <li key={index}>{inline(item, `${key}.${index}`)}</li>)}</ul>
    case "table": return (
      <div key={key} className="markdown-table-scroll">
        <table>
          <thead><tr>{block.header.map((cell, index) => <th key={index}>{inline(cell, `${key}.h${index}`)}</th>)}</tr></thead>
          <tbody>{block.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>{row.map((cell, index) => <td key={index}>{inline(cell, `${key}.${rowIndex}.${index}`)}</td>)}</tr>
          ))}</tbody>
        </table>
      </div>
    )
    case "paragraph": return <p key={key}>{inline(block.text, key)}</p>
  }
}

/** Renders markdown as React elements only — there is no `dangerouslySetInnerHTML` on this
 *  path, which is what replaces the sandbox the ReadyApp `/share` renderer relies on.
 *
 *  `variant` picks the context: `document` for the viewer pane, `chat` for a transcript
 *  message (Discord soft-break semantics, damped headings, message-scale rhythm). */
export function Markdown({ source, variant = "document" }: { source: string; variant?: MarkdownVariant }): JSX.Element {
  return (
    <div className="markdown-body" data-variant={variant}>
      {parseBlocks(source).map((block, index) => renderBlock(block, `b${index}`, variant))}
    </div>
  )
}
