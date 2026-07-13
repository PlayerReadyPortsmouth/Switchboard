import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { rmSync } from "node:fs"
import sharp from "sharp"

const outdir = "dist/web"

function build() {
  const result = Bun.spawnSync({ cmd: [process.execPath, "run", "scripts/build-web.ts"], stdout: "pipe", stderr: "pipe" })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
}

async function outputDigest() {
  const paths = [...new Bun.Glob("**/*").scanSync(outdir)].sort()
  const hash = createHash("sha256")
  for (const path of paths) hash.update(path).update("\0").update(await Bun.file(`${outdir}/${path}`).bytes()).update("\0")
  return hash.digest("hex")
}

function serviceWorkerHarness(source: string) {
  const listeners = new Map<string, (event: any) => void>()
  const added: string[][] = []
  const cachedRequests: string[] = []
  const deleted: string[] = []
  let claimed = 0
  const hits = new Map<string, Response>()
  const networkRequests: string[] = []
  const cache = { addAll: async (assets: string[]) => { added.push(assets) }, put: async (request: Request) => { cachedRequests.push(request.url) } }
  const caches = {
    open: async () => cache,
    keys: async () => ["switchboard-shell-old", "unrelated-cache"],
    delete: async (name: string) => { deleted.push(name); return true },
    match: async (request: Request | string) => hits.get(typeof request === "string" ? request : request.url),
  }
  const self = {
    location: { origin: "https://switchboard.test" },
    clients: { claim: async () => { claimed++ } },
    skipWaiting: async () => {},
    addEventListener: (type: string, listener: (event: any) => void) => listeners.set(type, listener),
  }
  const network = async (request: Request) => { networkRequests.push(request.url); return new Response(request.url) }
  new Function("self", "caches", "fetch", source)(self, caches, network)
  return { listeners, added, cachedRequests, deleted, claimed: () => claimed, networkRequests, setCached: (key: string, response: Response) => hits.set(key, response) }
}

describe("PWA build", () => {
  test("emits a stable install manifest and exact-size local icons", async () => {
    rmSync(outdir, { recursive: true, force: true })
    build()

    const html = await Bun.file(`${outdir}/index.html`).text()
    expect(html).toContain('href="/manifest.webmanifest"')
    expect(html).toContain('href="/icons/icon-192.png"')

    const manifest = await Bun.file(`${outdir}/manifest.webmanifest`).json()
    expect(manifest).toMatchObject({
      id: "/",
      name: "Switchboard Workspace",
      short_name: "Switchboard",
      start_url: "/",
      scope: "/",
      display: "standalone",
      background_color: "#0b0f17",
      theme_color: "#121722",
      prefer_related_applications: false,
    })
    expect(manifest.icons).toEqual([
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ])
    for (const [name, size] of [["icon-192.png", 192], ["icon-512.png", 512], ["maskable-512.png", 512]] as const) {
      const metadata = await sharp(`${outdir}/icons/${name}`).metadata()
      expect([metadata.width, metadata.height]).toEqual([size, size])
    }
  })

  test("produces byte-for-byte deterministic outputs", async () => {
    build()
    const first = await outputDigest()
    build()
    expect(await outputDigest()).toBe(first)
  })

  test("versions the service-worker cache from the actual shell assets", async () => {
    build()
    const source = await Bun.file(`${outdir}/sw.js`).text()
    const assets = JSON.parse(source.match(/const SHELL_ASSETS = (\[[^;]+\])/s)?.[1] ?? "null") as string[]
    const cacheName = source.match(/const CACHE_NAME = "switchboard-shell-([a-f0-9]+)"/)?.[1]
    expect(assets).toEqual(expect.arrayContaining([
      "/", "/index.html", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/maskable-512.png",
    ]))
    expect(assets.some(path => path.endsWith(".js"))).toBe(true)
    expect(assets.some(path => path.endsWith(".css"))).toBe(true)
    expect(assets.every(path => !path.endsWith(".map"))).toBe(true)
    const hash = createHash("sha256")
    for (const path of assets.filter(path => path !== "/")) {
      hash.update(path).update("\0").update(await Bun.file(`${outdir}${path}`).bytes()).update("\0")
    }
    expect(cacheName).toBe(hash.digest("hex").slice(0, 16))
  })

  test("installs the shell and removes only prior Switchboard shell caches", async () => {
    build()
    const harness = serviceWorkerHarness(await Bun.file(`${outdir}/sw.js`).text())
    let installWork!: Promise<unknown>
    harness.listeners.get("install")!({ waitUntil: (work: Promise<unknown>) => { installWork = work } })
    await installWork
    expect(harness.added).toHaveLength(1)
    expect(harness.added[0]).toContain("/index.html")

    let activateWork!: Promise<unknown>
    harness.listeners.get("activate")!({ waitUntil: (work: Promise<unknown>) => { activateWork = work } })
    await activateWork
    expect(harness.deleted).toEqual(["switchboard-shell-old"])
    expect(harness.claimed()).toBe(1)
  })

  test("bypasses APIs and event streams before respondWith", async () => {
    build()
    const harness = serviceWorkerHarness(await Bun.file(`${outdir}/sw.js`).text())
    const dispatch = (request: Request) => {
      let response: Promise<Response> | undefined
      harness.listeners.get("fetch")!({ request, respondWith: (value: Promise<Response>) => { response = value } })
      return response
    }
    expect(dispatch(new Request("https://switchboard.test/api/conversations"))).toBeUndefined()
    expect(dispatch(new Request("https://switchboard.test/conversations/1/events", { headers: { accept: "text/event-stream" } }))).toBeUndefined()
    expect(dispatch(new Request("https://switchboard.test/", { method: "POST" }))).toBeUndefined()
    expect(dispatch(new Request("https://elsewhere.test/app.js"))).toBeUndefined()
    expect(dispatch(new Request("https://switchboard.test/index.html"))).toBeInstanceOf(Promise)
    await dispatch(new Request("https://switchboard.test/conversations/private"))
    expect(harness.cachedRequests).toEqual([])
  })

  test("navigation requests fall back to the cached shell without caching authenticated responses", async () => {
    build()
    const source = await Bun.file(`${outdir}/sw.js`).text()
    const harness = serviceWorkerHarness(source)
    harness.setCached("/index.html", new Response("cached shell"))
    let response!: Promise<Response>
    const request = { url: "https://switchboard.test/conversations/deep", method: "GET", mode: "navigate", headers: new Headers() } as Request
    harness.listeners.get("fetch")!({ request, respondWith: (value: Promise<Response>) => { response = value } })
    expect(await (await response).text()).toBe("cached shell")
    expect(harness.networkRequests).toEqual([])
    expect(harness.cachedRequests).toEqual([])
    expect(source).not.toContain("cache.put(")
  })
})
