import { createHash } from "node:crypto"
import { cp, mkdir, rm } from "node:fs/promises"
import { generatePwaIcons } from "./generate-pwa-icons"
import { normalizeWebBase } from "../web/webBase"

const outdir = "dist/web"
const publicDir = "web/client/public"
// Build-time URL base path. Unset → "/" and byte-identical output to a base-less build.
const BASE = normalizeWebBase(process.env.SWITCHBOARD_WEB_BASE)

await rm(outdir, { recursive: true, force: true })
await mkdir(outdir, { recursive: true })
const result = await Bun.build({
  entrypoints: ["web/client/index.html"],
  outdir,
  target: "browser",
  publicPath: BASE,
  minify: true,
  sourcemap: "external",
})
if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
if (!(await Bun.file(`${outdir}/index.html`).exists())) throw new Error("Web build did not emit index.html")

await cp(publicDir, outdir, { recursive: true })
await rm(`${outdir}/sw.template.js`)
await generatePwaIcons(`${publicDir}/icon.svg`, `${outdir}/icons`)

const htmlPath = `${outdir}/index.html`
const html = await Bun.file(htmlPath).text()
// The base meta lets the client read the base at runtime; omitted for "/" to stay byte-identical.
const baseMeta = BASE === "/" ? "" : `    <meta name="switchboard-base" content="${BASE}" />\n`
const pwaLinks = `${baseMeta}    <link rel="manifest" href="${BASE}manifest.webmanifest" />\n    <link rel="icon" href="${BASE}icons/icon-192.png" />\n`
await Bun.write(htmlPath, html.replace("    <title>Switchboard</title>", `${pwaLinks}    <title>Switchboard</title>`))

// The manifest is copied verbatim (see cp above). Only re-template it when a base is set, so the
// default build keeps the hand-formatted source byte-for-byte.
if (BASE !== "/") {
  const manifestPath = `${outdir}/manifest.webmanifest`
  const manifest = await Bun.file(manifestPath).json()
  manifest.id = BASE
  manifest.start_url = BASE
  manifest.scope = BASE
  manifest.icons = (manifest.icons as Array<{ src: string }>).map(icon => ({ ...icon, src: `${BASE}${String(icon.src).replace(/^\/+/, "")}` }))
  await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

const shellExtensions = new Set([".html", ".js", ".css", ".png", ".svg", ".webmanifest"])
const relPaths = [...new Bun.Glob("**/*").scanSync(outdir)]
  .filter(path => shellExtensions.has(`.${path.split(".").at(-1)}`))
  .map(path => path.replaceAll("\\", "/"))
  .sort()
// Served paths are base-prefixed: the root (BASE) plus each asset.
const shellAssets = [BASE, ...relPaths.map(path => `${BASE}${path}`)]
const version = createHash("sha256")
for (const path of relPaths) version.update(`${BASE}${path}`).update("\0").update(await Bun.file(`${outdir}/${path}`).bytes()).update("\0")

const template = await Bun.file(`${publicDir}/sw.template.js`).text()
const serviceWorker = template
  .replace("__SWITCHBOARD_SHELL_ASSETS__", JSON.stringify(shellAssets))
  .replace("__SWITCHBOARD_CACHE_VERSION__", version.digest("hex").slice(0, 16))
  .replace("__SWITCHBOARD_BASE__", BASE)
await Bun.write(`${outdir}/sw.js`, serviceWorker)
