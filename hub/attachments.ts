import type { FoldableAttachment } from "./enrich"

/** A Discord attachment as captured at the gateway: metadata plus the CDN url
 *  the bytes can be fetched from (absent ⇒ nothing to download). */
export interface RawAttachment {
  name: string
  type: string
  size: number
  url?: string
}

export interface MaterializeOpts {
  dir: string          // directory the downloaded files are written under
  maxBytes?: number    // skip (don't fetch) any attachment larger than this
}

/** Injected I/O so the downloader is unit-testable without a network or disk. */
export interface MaterializeDeps {
  fetch: (url: string) => Promise<{ ok: boolean; arrayBuffer: () => Promise<ArrayBuffer> }>
  writeFile: (path: string, data: Uint8Array) => Promise<void>
  mkdir: (dir: string) => Promise<void>
}

/** Keep a filename safe to drop into a path: collapse anything that isn't a
 *  word char, dot or dash to "_". Index-prefixed by the caller to avoid clashes. */
function safeName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, "_")
  return cleaned || "file"
}

/** Download each attachment's bytes to `dir`, returning the same list with a
 *  local `path` where the download succeeded. Files with no url, over `maxBytes`,
 *  or whose fetch fails come back with `path` undefined — one failure never aborts
 *  the rest. Order is preserved so the result lines up with the input. */
export async function materializeAttachments(
  atts: RawAttachment[], opts: MaterializeOpts, deps: MaterializeDeps,
): Promise<FoldableAttachment[]> {
  await deps.mkdir(opts.dir)
  const out: FoldableAttachment[] = []
  for (let i = 0; i < atts.length; i++) {
    const a = atts[i]!
    const base: FoldableAttachment = { name: a.name, type: a.type, size: a.size }
    if (!a.url || (opts.maxBytes !== undefined && a.size > opts.maxBytes)) {
      out.push(base)
      continue
    }
    try {
      const res = await deps.fetch(a.url)
      if (!res.ok) { out.push(base); continue }
      const bytes = new Uint8Array(await res.arrayBuffer())
      const path = `${opts.dir}/${i}_${safeName(a.name)}`
      await deps.writeFile(path, bytes)
      out.push({ ...base, path })
    } catch {
      out.push(base)
    }
  }
  return out
}
