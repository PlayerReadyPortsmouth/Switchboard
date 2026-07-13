import { extname, resolve, sep } from "node:path"

export type WorkspaceAssetHandler = (pathname: string) => Promise<Response | null>

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json; charset=utf-8",
}

const NO_CACHE = new Set(["/index.html", "/sw.js", "/manifest.webmanifest"])
const CONTENT_HASH = /(?:^|[-.])[A-Za-z0-9]{6,}(?=\.[^.]+$)/

export function createBuiltWorkspaceAssets(root = resolve(import.meta.dir, "../dist/web")): WorkspaceAssetHandler {
  const assetRoot = resolve(root)
  const rootPrefix = assetRoot.endsWith(sep) ? assetRoot : `${assetRoot}${sep}`

  return async pathname => {
    let decoded: string
    try {
      decoded = decodeURIComponent(pathname)
    } catch {
      return null
    }

    const isWorkspaceRoute = decoded === "/" || extname(decoded) === ""
    const servedPath = isWorkspaceRoute ? "/index.html" : decoded
    const target = resolve(assetRoot, `.${servedPath}`)
    if (target !== assetRoot && !target.startsWith(rootPrefix)) return null

    const mime = MIME_TYPES[extname(target).toLowerCase()]
    if (!mime) return null
    const file = Bun.file(target)
    if (!(await file.exists())) return null

    const headers = new Headers({ "content-type": mime })
    if (NO_CACHE.has(servedPath)) {
      headers.set("cache-control", "no-cache")
    } else if ((decoded.startsWith("/assets/") || decoded.startsWith("/icons/")) && CONTENT_HASH.test(decoded.split("/").at(-1) ?? "")) {
      headers.set("cache-control", "public, max-age=31536000, immutable")
    }
    return new Response(file, { headers })
  }
}
