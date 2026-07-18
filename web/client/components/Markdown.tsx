import type { JSX, ReactNode } from "react"
import { parseBlocks, parseInline, safeUrl, type Block, type Inline } from "../markdown"

function renderInline(nodes: Inline[], keyPrefix: string): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}.${index}`
    switch (node.kind) {
      case "text": return node.value
      case "code": return <code key={key}>{node.value}</code>
      case "strong": return <strong key={key}>{renderInline(node.children, key)}</strong>
      case "em": return <em key={key}>{renderInline(node.children, key)}</em>
      case "del": return <del key={key}>{renderInline(node.children, key)}</del>
      case "image": {
        const src = safeUrl(node.href)
        // A rejected URL degrades to the alt text rather than vanishing, so nothing is silently lost.
        return src ? <img key={key} src={src} alt={node.alt} /> : <span key={key}>{node.alt}</span>
      }
      case "link": {
        const href = safeUrl(node.href)
        return href
          ? <a key={key} href={href} target="_blank" rel="noopener noreferrer nofollow">{renderInline(node.children, key)}</a>
          : <span key={key}>{renderInline(node.children, key)}</span>
      }
    }
  })
}

function renderBlock(block: Block, key: string): ReactNode {
  switch (block.kind) {
    case "rule": return <hr key={key} />
    case "code": return <pre key={key} data-language={block.language || undefined}><code>{block.text}</code></pre>
    case "quote": return <blockquote key={key}>{renderInline(parseInline(block.text), key)}</blockquote>
    case "heading": {
      const Tag = `h${Math.min(block.level + 1, 6)}` as "h2" | "h3" | "h4" | "h5" | "h6"
      // Shifted one level down: the viewer pane already owns the document's <h1>.
      return <Tag key={key}>{renderInline(parseInline(block.text), key)}</Tag>
    }
    case "list": return block.ordered
      ? <ol key={key}>{block.items.map((item, index) => <li key={index}>{renderInline(parseInline(item), `${key}.${index}`)}</li>)}</ol>
      : <ul key={key}>{block.items.map((item, index) => <li key={index}>{renderInline(parseInline(item), `${key}.${index}`)}</li>)}</ul>
    case "table": return (
      <div key={key} className="markdown-table-scroll">
        <table>
          <thead><tr>{block.header.map((cell, index) => <th key={index}>{renderInline(parseInline(cell), `${key}.h${index}`)}</th>)}</tr></thead>
          <tbody>{block.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>{row.map((cell, index) => <td key={index}>{renderInline(parseInline(cell), `${key}.${rowIndex}.${index}`)}</td>)}</tr>
          ))}</tbody>
        </table>
      </div>
    )
    case "paragraph": return <p key={key}>{renderInline(parseInline(block.text), key)}</p>
  }
}

/** Renders markdown as React elements only — there is no `dangerouslySetInnerHTML` on this
 *  path, which is what replaces the sandbox the ReadyApp `/share` renderer relies on. */
export function Markdown({ source }: { source: string }): JSX.Element {
  return <div className="markdown-body">{parseBlocks(source).map((block, index) => renderBlock(block, `b${index}`))}</div>
}
