import { test, expect } from "bun:test"
import { permittedAgents } from "../hub/access"
import type { AgentRegistry } from "../hub/types"

const reg: AgentRegistry = {
  research: { emoji: "🔬", description: "", mode: "persistent",
    access: { roles: ["dev", "admin"], users: [] }, runtime: { cwd: "." } },
  deploy: { emoji: "🚀", description: "", mode: "persistent",
    access: { roles: ["admin"], users: ["111"] }, runtime: { cwd: "." } },
  qa: { emoji: "💡", description: "", mode: "ephemeral",
    access: { roles: ["*"] }, runtime: { cwd: "." } },
}

test("role intersection grants access", () => {
  expect(permittedAgents(reg, ["dev"], "999").sort()).toEqual(["qa", "research"])
})

test("admin sees role-gated agents", () => {
  expect(permittedAgents(reg, ["admin"], "999").sort()).toEqual(["deploy", "qa", "research"])
})

test("user-id grant works without a role", () => {
  expect(permittedAgents(reg, [], "111").sort()).toEqual(["deploy", "qa"])
})

test('"*" agent is available to any paired user', () => {
  expect(permittedAgents(reg, [], "999")).toEqual(["qa"])
})
