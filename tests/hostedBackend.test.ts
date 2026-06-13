import { test, expect } from "bun:test"
import { HttpEmbedder } from "../hub/memory/httpEmbedder"
import { QdrantIndex, pointId } from "../hub/memory/qdrantIndex"
import type { HttpFetch, HttpResponse } from "../hub/memory/memoryIndex"

interface Call { url: string; method: string; headers: Record<string, string>; body?: any }
function fakeHttp(responses: any[]): { fetch: HttpFetch; calls: Call[] } {
  const calls: Call[] = []
  const fetch: HttpFetch = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined })
    const r = responses.shift() ?? {}
    const resp: HttpResponse = { ok: r.ok ?? true, status: r.status ?? 200, json: async () => r.json ?? {} }
    return resp
  }
  return { fetch, calls }
}

// --- HttpEmbedder (OpenAI-compatible) ---
test("HttpEmbedder posts to /embeddings and orders by index", async () => {
  const { fetch, calls } = fakeHttp([
    { json: { data: [{ index: 1, embedding: [9, 9] }, { index: 0, embedding: [1, 1] }] } },
  ])
  const e = new HttpEmbedder({ baseUrl: "https://api.example.com/v1/", apiKey: "sk-x", model: "text-embedding-3-small", fetch })
  expect(e.version).toBe("text-embedding-3-small")
  const out = await e.embed(["a", "b"])
  expect(out).toEqual([[1, 1], [9, 9]])             // re-sorted by `index`
  expect(calls[0].url).toBe("https://api.example.com/v1/embeddings")
  expect(calls[0].headers.authorization).toBe("Bearer sk-x")
  expect(calls[0].body).toEqual({ model: "text-embedding-3-small", input: ["a", "b"] })
})

test("HttpEmbedder throws on a non-ok response", async () => {
  const { fetch } = fakeHttp([{ ok: false, status: 429 }])
  const e = new HttpEmbedder({ baseUrl: "https://x/v1", model: "m", fetch })
  await expect(e.embed(["a"])).rejects.toThrow()
})

// --- QdrantIndex ---
test("pointId is a stable UUID-shaped hash of the path", () => {
  expect(pointId("/a")).toBe(pointId("/a"))
  expect(pointId("/a")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
})

test("set lazily creates the collection then upserts a point with payload", async () => {
  const { fetch, calls } = fakeHttp([{}, {}])
  const q = new QdrantIndex({ url: "http://localhost:6333", apiKey: "k", collection: "mem", fetch })
  await q.set("/g/a.md", "global", [0.1, 0.2], "v1")
  expect(calls[0].method).toBe("PUT")
  expect(calls[0].url).toBe("http://localhost:6333/collections/mem")
  expect(calls[0].body).toEqual({ vectors: { size: 2, distance: "Cosine" } })
  expect(calls[0].headers["api-key"]).toBe("k")
  expect(calls[1].url).toBe("http://localhost:6333/collections/mem/points")
  expect(calls[1].body.points[0]).toEqual({ id: pointId("/g/a.md"), vector: [0.1, 0.2], payload: { path: "/g/a.md", scope: "global", version: "v1" } })
})

test("search filters by scope + version and maps payloads to hits", async () => {
  const { fetch, calls } = fakeHttp([
    { json: { result: [{ score: 0.9, payload: { path: "/g/a.md", scope: "global" } }] } },
  ])
  const q = new QdrantIndex({ url: "http://localhost:6333", collection: "mem", fetch })
  const hits = await q.search([1, 0], ["global", "users/1"], 5, "v1")
  expect(hits).toEqual([{ path: "/g/a.md", scope: "global", score: 0.9 }])
  expect(calls[0].url).toBe("http://localhost:6333/collections/mem/points/search")
  expect(calls[0].body.limit).toBe(5)
  expect(calls[0].body.filter.must).toEqual([
    { key: "scope", match: { any: ["global", "users/1"] } },
    { key: "version", match: { value: "v1" } },
  ])
})

test("remove deletes by point id", async () => {
  const { fetch, calls } = fakeHttp([{}])
  const q = new QdrantIndex({ url: "http://localhost:6333", collection: "mem", fetch })
  await q.remove("/g/a.md")
  expect(calls[0].url).toBe("http://localhost:6333/collections/mem/points/delete")
  expect(calls[0].body).toEqual({ points: [pointId("/g/a.md")] })
})

test("collection is ensured only once across writes", async () => {
  const { fetch, calls } = fakeHttp([{}, {}, {}])
  const q = new QdrantIndex({ url: "http://x", collection: "mem", fetch })
  await q.set("/a", "global", [1], "v1")
  await q.set("/b", "global", [1], "v1")
  const ensures = calls.filter((c) => c.method === "PUT" && c.url === "http://x/collections/mem")
  expect(ensures.length).toBe(1)
})
