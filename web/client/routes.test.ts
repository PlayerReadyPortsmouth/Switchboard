import { expect, test } from "bun:test"
import { parseWorkspaceRoute, pathForAgent, pathForConversation, pathForDocument } from "./routes"

test("parses conversation and agent workspace routes", () => {
  expect(parseWorkspaceRoute("/")).toEqual({ destination: "conversations", conversationId: null })
  expect(parseWorkspaceRoute("/conversations/design%2Freview")).toEqual({ destination: "conversations", conversationId: "design/review" })
  expect(parseWorkspaceRoute("/agents")).toEqual({ destination: "agents", agent: null })
  expect(parseWorkspaceRoute("/agents/design%2Freview")).toEqual({ destination: "agents", agent: "design/review" })
})

test("parses document workspace routes", () => {
  expect(parseWorkspaceRoute("/documents")).toEqual({ destination: "documents", token: null })
  expect(parseWorkspaceRoute("/documents/tok%2F1")).toEqual({ destination: "documents", token: "tok/1" })
  expect(parseWorkspaceRoute("/documents/%E0%A4%A")).toEqual({ destination: "not_found" })
})

test("builds encoded document paths", () => {
  expect(pathForDocument(null)).toBe("/documents")
  expect(pathForDocument("tok/1")).toBe("/documents/tok%2F1")
  expect(pathForDocument(null, "/switchboard/")).toBe("/switchboard/documents")
  expect(pathForDocument("tok/1", "/switchboard/")).toBe("/switchboard/documents/tok%2F1")
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

test("parses workspace routes under a non-root base", () => {
  const base = "/switchboard/"
  expect(parseWorkspaceRoute("/switchboard/", base)).toEqual({ destination: "conversations", conversationId: null })
  expect(parseWorkspaceRoute("/switchboard", base)).toEqual({ destination: "conversations", conversationId: null })
  expect(parseWorkspaceRoute("/switchboard/agents", base)).toEqual({ destination: "agents", agent: null })
  expect(parseWorkspaceRoute("/switchboard/conversations/design%2Freview", base)).toEqual({ destination: "conversations", conversationId: "design/review" })
  expect(parseWorkspaceRoute("/switchboard/agents/design%2Freview", base)).toEqual({ destination: "agents", agent: "design/review" })
})

test("rejects routes outside the configured base", () => {
  const base = "/switchboard/"
  expect(parseWorkspaceRoute("/", base)).toEqual({ destination: "not_found" })
  expect(parseWorkspaceRoute("/agents", base)).toEqual({ destination: "not_found" })
  expect(parseWorkspaceRoute("/other/agents", base)).toEqual({ destination: "not_found" })
  expect(parseWorkspaceRoute("/switchboardish/agents", base)).toEqual({ destination: "not_found" })
})

test("builds encoded workspace paths under a non-root base", () => {
  const base = "/switchboard/"
  expect(pathForConversation(null, base)).toBe("/switchboard/")
  expect(pathForConversation("design/review", base)).toBe("/switchboard/conversations/design%2Freview")
  expect(pathForAgent(null, base)).toBe("/switchboard/agents")
  expect(pathForAgent("design/review", base)).toBe("/switchboard/agents/design%2Freview")
})
