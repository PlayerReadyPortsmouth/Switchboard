import { test, expect } from "bun:test"
import { PermissionRouter } from "../hub/permissions"
import { parsePermissionReply } from "../hub/permissions"

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

test("parses an allow reply", () => {
  expect(parsePermissionReply("y abcde")).toEqual({ behavior: "allow", code: "abcde" })
  expect(parsePermissionReply("YES abcde")).toEqual({ behavior: "allow", code: "abcde" })
})

test("parses a deny reply", () => {
  expect(parsePermissionReply("n abcde")).toEqual({ behavior: "deny", code: "abcde" })
  expect(parsePermissionReply("no abcde")).toEqual({ behavior: "deny", code: "abcde" })
})

test("rejects non-permission text", () => {
  expect(parsePermissionReply("no idea what to do")).toBeNull()
  expect(parsePermissionReply("yes")).toBeNull()
  expect(parsePermissionReply("hello there")).toBeNull()
})
