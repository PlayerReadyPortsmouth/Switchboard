import { test, expect, describe } from "bun:test"
import { parseRouterOutput, buildRouterPrompt, route, addressedAgent } from "../hub/router"

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

describe("router big-request flag", () => {
  test("the prompt asks for a big flag", () => {
    const { system } = buildRouterPrompt({ message: "hi", permitted: [{ name: "a", description: "d" }], current: null })
    expect(system).toContain("\"big\": <bool>")
  })
  test("big:true is carried on the decision", () => {
    expect(parseRouterOutput("{\"agent\":\"a\",\"confidence\":0.9,\"switch\":false,\"big\":true}", ["a"])?.big).toBe(true)
  })
  test("big absent, false or non-boolean is left off the decision", () => {
    expect(parseRouterOutput("{\"agent\":\"a\",\"confidence\":0.9,\"switch\":false}", ["a"])).toEqual({ agent: "a", confidence: 0.9, switch: false })
    expect(parseRouterOutput("{\"agent\":\"a\",\"confidence\":0.9,\"switch\":false,\"big\":false}", ["a"])?.big).toBeUndefined()
    expect(parseRouterOutput("{\"agent\":\"a\",\"confidence\":0.9,\"switch\":false,\"big\":\"yes\"}", ["a"])?.big).toBeUndefined()
  })
})

describe("addressedAgent", () => {
  const team = ["Bill", "Susie", "Geoff", "Stacy", "Ted"]
  test("a name at the start addresses that agent, with or without a greeting", () => {
    expect(addressedAgent("Hey Bill, can you ask Susie why a function may return null pointer", team)).toBe("Bill")
    expect(addressedAgent("Bill: what was VAT last month?", team)).toBe("Bill")
    expect(addressedAgent("@susie the dashboard is down", team)).toBe("Susie")
    expect(addressedAgent("  ok geoff - chase that council", team)).toBe("Geoff")
    expect(addressedAgent("Ted", team)).toBe("Ted")
    expect(addressedAgent("Thanks Stacy!", team)).toBe("Stacy")
  })
  test("a name later in the message addresses nobody", () => {
    expect(addressedAgent("Can someone ask Susie about this?", team)).toBeNull()
    expect(addressedAgent("As Bill said earlier, the VAT is wrong", team)).toBeNull()
  })
  test("only a whole name counts", () => {
    expect(addressedAgent("Billing is broken", team)).toBeNull()
    expect(addressedAgent("Teddy bears are on sale", team)).toBeNull()
    expect(addressedAgent("Bill's numbers look off", team)).toBeNull()
  })
  test("an agent the caller is not permitted is never returned", () => {
    expect(addressedAgent("Susie, why is this null?", ["Bill", "Ted"])).toBeNull()
  })
  test("no agents, or an empty message, addresses nobody", () => {
    expect(addressedAgent("Hey Bill", [])).toBeNull()
    expect(addressedAgent("", team)).toBeNull()
    expect(addressedAgent("hey", team)).toBeNull()
  })
})
