import { rm, mkdir } from "node:fs/promises"

const outdir = "dist/web"
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
