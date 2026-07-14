import { expect, test } from "bun:test"
import { agentsFeatureEnabled, resolveWorkspaceRole } from "./access"

test("agents stays hidden until explicitly enabled", () => {
  expect(agentsFeatureEnabled(undefined)).toBe(false)
  expect(agentsFeatureEnabled({ features: { agents: true } })).toBe(true)
})

test("an unconfigured policy preserves trusted-header operator compatibility", () => {
  expect(resolveWorkspaceRole("ada@example.com", undefined)).toBe("operator")
})

test("configured lists distinguish viewer, operator, wildcard, and hidden", () => {
  const config = { viewers: ["viewer@example.com"], operators: ["ops@example.com"] }
  expect(resolveWorkspaceRole("viewer@example.com", config)).toBe("viewer")
  expect(resolveWorkspaceRole("ops@example.com", config)).toBe("operator")
  expect(resolveWorkspaceRole("other@example.com", config)).toBe("hidden")
  expect(resolveWorkspaceRole("anyone@example.com", { viewers: ["*"] })).toBe("viewer")
})
