import { createHash } from "node:crypto"
import { cp, mkdir, rm } from "node:fs/promises"
import { generatePwaIcons } from "./generate-pwa-icons"

const outdir = "dist/web"
const publicDir = "web/client/public"

await rm(outdir, { recursive: true, force: true })
await mkdir(outdir, { recursive: true })
const result = await Bun.build({
  entrypoints: ["web/client/index.html"],
  outdir,
  target: "browser",
  publicPath: "/",
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
const pwaLinks = '    <link rel="manifest" href="/manifest.webmanifest" />\n    <link rel="icon" href="/icons/icon-192.png" />\n'
await Bun.write(htmlPath, html.replace("    <title>Switchboard</title>", `${pwaLinks}    <title>Switchboard</title>`))

const shellExtensions = new Set([".html", ".js", ".css", ".png", ".svg", ".webmanifest"])
const outputPaths = [...new Bun.Glob("**/*").scanSync(outdir)]
  .filter(path => shellExtensions.has(`.${path.split(".").at(-1)}`))
  .map(path => `/${path.replaceAll("\\", "/")}`)
  .sort()
const shellAssets = ["/", ...outputPaths]
const version = createHash("sha256")
for (const path of outputPaths) version.update(path).update("\0").update(await Bun.file(`${outdir}${path}`).bytes()).update("\0")

const template = await Bun.file(`${publicDir}/sw.template.js`).text()
const serviceWorker = template
  .replace("__SWITCHBOARD_SHELL_ASSETS__", JSON.stringify(shellAssets))
  .replace("__SWITCHBOARD_CACHE_VERSION__", version.digest("hex").slice(0, 16))
await Bun.write(`${outdir}/sw.js`, serviceWorker)
