import { expect, test } from "bun:test"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createBuiltWorkspaceAssets } from "../hub/webAssets"

async function tempWorkspace(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "switchboard-web-assets-"))
  await Promise.all(Object.entries(files).map(async ([path, contents]) => {
    const target = join(root, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, contents)
  }))
  return root
}

test("serves index for workspace routes and immutable hashed assets", async () => {
  const root = await tempWorkspace({
    "index.html": "<main id=\"root\"></main>",
    "assets/main-ABC123.js": "export {}",
  })
  const assets = createBuiltWorkspaceAssets(root)
  expect(await (await assets("/"))!.text()).toContain("id=\"root\"")
  expect(await (await assets("/conversations/c1"))!.text()).toContain("id=\"root\"")
  expect((await assets("/assets/main-ABC123.js"))!.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
  expect(await assets("/../package.json")).toBeNull()
})
