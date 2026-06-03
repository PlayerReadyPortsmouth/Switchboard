import { test, expect } from "bun:test"
import { NotifyRouter } from "./notifyRouter"

test("maps a customId to the registering agent and keeps it (multi-click)", () => {
  const r = new NotifyRouter()
  r.register(["action:retry:B-1", "action:dismiss:B-1"], "assistant")
  expect(r.agentFor("action:retry:B-1")).toBe("assistant")
  expect(r.agentFor("action:dismiss:B-1")).toBe("assistant")
  // unknown id → undefined
  expect(r.agentFor("action:nope:B-9")).toBeUndefined()
})

test("forget() drops a card's ids", () => {
  const r = new NotifyRouter()
  r.register(["deploy:go:J1", "deploy:discard:J1"], "worker-1")
  r.forget(["deploy:go:J1", "deploy:discard:J1"])
  expect(r.agentFor("deploy:go:J1")).toBeUndefined()
})
