import { expect, test } from "bun:test"
import { parseWorkspaceRoute, pathForAgent, pathForConversation } from "./routes"

test("parses conversation and agent workspace routes", () => {
  expect(parseWorkspaceRoute("/")).toEqual({ destination: "conversations", conversationId: null })
  expect(parseWorkspaceRoute("/conversations/design%2Freview")).toEqual({ destination: "conversations", conversationId: "design/review" })
  expect(parseWorkspaceRoute("/agents")).toEqual({ destination: "agents", agent: null })
  expect(parseWorkspaceRoute("/agents/design%2Freview")).toEqual({ destination: "agents", agent: "design/review" })
})

test("rejects malformed and unknown workspace routes", () => {
  expect(parseWorkspaceRoute("/agents/%E0%A4%A")).toEqual({ destination: "not_found" })
  expect(parseWorkspaceRoute("/conversations/%E0%A4%A")).toEqual({ destination: "not_found" })
  expect(parseWorkspaceRoute("/elsewhere")).toEqual({ destination: "not_found" })
})

test("builds encoded workspace paths", () => {
  expect(pathForConversation(null)).toBe("/")
  expect(pathForConversation("design/review")).toBe("/conversations/design%2Freview")
  expect(pathForAgent(null)).toBe("/agents")
  expect(pathForAgent("design/review")).toBe("/agents/design%2Freview")
})
