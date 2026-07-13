import { mkdir } from "node:fs/promises"
import sharp from "sharp"

export async function generatePwaIcons(source: string, outdir: string) {
  await mkdir(outdir, { recursive: true })
  const render = (size: number, name: string) => sharp(source)
    .resize(size, size, { fit: "fill" })
    .png({ compressionLevel: 9, palette: true })
    .toFile(`${outdir}/${name}`)

  await Promise.all([
    render(192, "icon-192.png"),
    render(512, "icon-512.png"),
    render(512, "maskable-512.png"),
  ])
}

if (import.meta.main) await generatePwaIcons("web/client/public/icon.svg", "dist/web/icons")
