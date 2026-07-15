import { expect, test } from "bun:test"
import { parseWorkspaceRoute, pathForAgent, pathForApproval, pathForConversation } from "./routes"

test("parses conversation and agent workspace routes", () => {
  expect(parseWorkspaceRoute("/")).toEqual({ destination: "conversations", conversationId: null })
  expect(parseWorkspaceRoute("/conversations/design%2Freview")).toEqual({ destination: "conversations", conversationId: "design/review" })
  expect(parseWorkspaceRoute("/agents")).toEqual({ destination: "agents", agent: null })
  expect(parseWorkspaceRoute("/agents/design%2Freview")).toEqual({ destination: "agents", agent: "design/review" })
})

test("rejects malformed and unknown workspace routes", () => {
  expect(parseWorkspaceRoute("/agents/%E0%A4%A")).toEqual({ destination: "not_found" })
  expect(parseWorkspaceRoute("/approvals/%E0%A4%A")).toEqual({ destination: "not_found" })
  expect(parseWorkspaceRoute("/conversations/%E0%A4%A")).toEqual({ destination: "not_found" })
  expect(parseWorkspaceRoute("/elsewhere")).toEqual({ destination: "not_found" })
})

test("builds encoded workspace paths", () => {
  expect(pathForConversation(null)).toBe("/")
  expect(pathForConversation("design/review")).toBe("/conversations/design%2Freview")
  expect(pathForAgent(null)).toBe("/agents")
  expect(pathForAgent("design/review")).toBe("/agents/design%2Freview")
})

test("parses and builds approval list and encoded detail routes", () => {
  expect(parseWorkspaceRoute("/approvals")).toEqual({ destination: "approvals", approvalId: null })
  expect(parseWorkspaceRoute("/approvals/review%2F7")).toEqual({ destination: "approvals", approvalId: "review/7" })
  expect(pathForApproval(null)).toBe("/approvals")
  expect(pathForApproval("review/7")).toBe("/approvals/review%2F7")
  expect(pathForApproval(null, { group: "pending", conversationId: "conversation/1" }))
    .toBe("/approvals?group=pending&conversationId=conversation%2F1")
})

test("approval paths append only explicit query fields in deterministic order", () => {
  const query = { group: "history" as const, conversationId: "conversation/1", ignored: "secret" }
  expect(pathForApproval(null, query)).toBe("/approvals?group=history&conversationId=conversation%2F1")
})
