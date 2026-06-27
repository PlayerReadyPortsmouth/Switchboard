import { test, expect } from "bun:test"
import { materializeAttachments, type MaterializeDeps } from "../hub/attachments"

function fakeDeps(overrides: Partial<MaterializeDeps> = {}): {
  deps: MaterializeDeps; writes: { path: string; bytes: number }[]; mkdirs: string[]
} {
  const writes: { path: string; bytes: number }[] = []
  const mkdirs: string[] = []
  const deps: MaterializeDeps = {
    fetch: async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }),
    writeFile: async (path, data) => { writes.push({ path, bytes: data.byteLength }) },
    mkdir: async (dir) => { mkdirs.push(dir) },
    ...overrides,
  }
  return { deps, writes, mkdirs }
}

test("downloads each url to a sanitized, index-prefixed path under dir", async () => {
  const { deps, writes, mkdirs } = fakeDeps()
  const out = await materializeAttachments(
    [{ name: "my shot!.png", type: "image/png", size: 3, url: "https://cdn/x" }],
    { dir: "/state/att" }, deps,
  )
  expect(mkdirs).toEqual(["/state/att"])
  expect(writes).toEqual([{ path: "/state/att/0_my_shot_.png", bytes: 3 }])
  expect(out).toEqual([{ name: "my shot!.png", type: "image/png", size: 3, path: "/state/att/0_my_shot_.png" }])
})

test("skips files with no url (path undefined, nothing written)", async () => {
  const { deps, writes } = fakeDeps()
  const out = await materializeAttachments(
    [{ name: "a.txt", type: "text/plain", size: 9 }], { dir: "/d" }, deps,
  )
  expect(writes).toEqual([])
  expect(out).toEqual([{ name: "a.txt", type: "text/plain", size: 9, path: undefined }])
})

test("skips files over maxBytes without fetching", async () => {
  let fetched = false
  const { deps, writes } = fakeDeps({ fetch: async () => { fetched = true; return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) } } })
  const out = await materializeAttachments(
    [{ name: "big.zip", type: "application/zip", size: 999, url: "https://cdn/big" }],
    { dir: "/d", maxBytes: 100 }, deps,
  )
  expect(fetched).toBe(false)
  expect(writes).toEqual([])
  expect(out[0].path).toBeUndefined()
})

test("leaves path undefined when the download fails", async () => {
  const { deps, writes } = fakeDeps({ fetch: async () => ({ ok: false, arrayBuffer: async () => new ArrayBuffer(0) }) })
  const out = await materializeAttachments(
    [{ name: "x.png", type: "image/png", size: 3, url: "https://cdn/x" }], { dir: "/d" }, deps,
  )
  expect(writes).toEqual([])
  expect(out[0].path).toBeUndefined()
})

test("a single failed download does not abort the others", async () => {
  let n = 0
  const { deps, writes } = fakeDeps({
    fetch: async () => {
      n++
      if (n === 1) throw new Error("network")
      return { ok: true, arrayBuffer: async () => new Uint8Array([9]).buffer }
    },
  })
  const out = await materializeAttachments([
    { name: "first.png", type: "image/png", size: 1, url: "https://cdn/1" },
    { name: "second.png", type: "image/png", size: 1, url: "https://cdn/2" },
  ], { dir: "/d" }, deps)
  expect(out[0].path).toBeUndefined()
  expect(out[1].path).toBe("/d/1_second.png")
  expect(writes).toEqual([{ path: "/d/1_second.png", bytes: 1 }])
})
