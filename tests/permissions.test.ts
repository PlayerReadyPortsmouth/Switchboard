import { test, expect } from "bun:test"
import { PermissionRouter } from "../hub/permissions"

test("maps a request id to its originating agent and back", () => {
  const pr = new PermissionRouter()
  pr.register("req-1", "research")
  expect(pr.agentFor("req-1")).toBe("research")
})

test("resolving consumes the mapping", () => {
  const pr = new PermissionRouter()
  pr.register("req-1", "deploy")
  expect(pr.resolve("req-1")).toBe("deploy")
  expect(pr.agentFor("req-1")).toBeUndefined()
})

test("unknown request id resolves to undefined", () => {
  expect(new PermissionRouter().resolve("nope")).toBeUndefined()
})
