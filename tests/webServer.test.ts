import { test, expect } from "bun:test"
import { handleWebRequest } from "../hub/webServer"
import type { WebInput } from "../hub/web"

const input = (): WebInput => ({
  now: 1000, startedAt: 0,
  status: { now: 1000, agents: [], overseers: [], routes: [], routeRate10m: 0, ephemerals: [] },
  audit: { total: 0, byKind: {}, byOutcome: {}, costUsd: 0, actors: 0 },
  recent: [], pendingApprovals: 0,
})
const get = (path: string) => new Request(`http://hub${path}`, { method: "GET" })

test("GET / → 200 HTML dashboard", async () => {
  const res = handleWebRequest(get("/"), input)
  expect(res.status).toBe(200)
  expect(res.headers.get("content-type")).toContain("text/html")
  expect((await res.text()).startsWith("<!doctype html>")).toBe(true)
})

test("GET /api/status → 200 JSON payload", async () => {
  const res = handleWebRequest(get("/api/status"), input)
  expect(res.status).toBe(200)
  expect(res.headers.get("content-type")).toContain("application/json")
  expect(JSON.parse(await res.text()).status).toBe("ok")
})

test("POST → 405, unknown path → 404", () => {
  expect(handleWebRequest(new Request("http://hub/", { method: "POST" }), input).status).toBe(405)
  expect(handleWebRequest(get("/nope"), input).status).toBe(404)
})
