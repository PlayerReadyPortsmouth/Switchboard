import { test, expect } from "bun:test"
import { parseRouterOutput, buildRouterPrompt, route } from "../hub/router"

const permitted = ["research", "deploy", "qa"]

test("parses a clean JSON decision", () => {
  const d = parseRouterOutput('{"agent":"deploy","confidence":0.9,"switch":true}', permitted)
  expect(d).toEqual({ agent: "deploy", confidence: 0.9, switch: true })
})

test("extracts JSON embedded in prose", () => {
  const d = parseRouterOutput('Sure! {"agent":"qa","confidence":0.4,"switch":false} done', permitted)
  expect(d?.agent).toBe("qa")
})

test("rejects an agent outside the permitted set", () => {
  expect(parseRouterOutput('{"agent":"root","confidence":1,"switch":true}', permitted)).toBeNull()
})

test("returns null on garbage", () => {
  expect(parseRouterOutput("no json here", permitted)).toBeNull()
})

test("clamps confidence to [0,1]", () => {
  expect(parseRouterOutput('{"agent":"qa","confidence":5,"switch":false}', permitted)?.confidence).toBe(1)
})

test("prompt lists each permitted agent's description", () => {
  const { user } = buildRouterPrompt({
    message: "deploy to prod",
    permitted: [{ name: "deploy", description: "prod deploys" }],
    current: null,
  })
  expect(user).toContain("deploy")
  expect(user).toContain("prod deploys")
})

test("route() returns the parsed decision from the runner", async () => {
  const run = async () => '{"agent":"research","confidence":0.8,"switch":true}'
  const d = await route(
    { message: "research X", permitted: [{ name: "research", description: "r" }], current: null },
    run, "claude-haiku-4-5",
  )
  expect(d?.agent).toBe("research")
})

test("route() returns null when the runner throws", async () => {
  const run = async () => { throw new Error("spawn failed") }
  const d = await route(
    { message: "x", permitted: [{ name: "research", description: "r" }], current: null },
    run, "claude-haiku-4-5",
  )
  expect(d).toBeNull()
})
