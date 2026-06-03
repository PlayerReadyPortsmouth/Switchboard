import { test, expect } from "bun:test"
import { matchGatedAction, gatedActionArg, requiresApprover, interpolateCommand } from "./gatedActions"
import type { GatedAction } from "./types"

const actions: GatedAction[] = [
  { namespace: "deploy", action: "go", approverOnly: true, command: "deploy.sh $arg",
    terminateAgent: true, pendingText: "p", successText: "s", failureText: "f" },
  { namespace: "fix", action: "cancel", command: "cancel.sh $arg",
    terminateAgent: true, pendingText: "p", successText: "s", failureText: "f" },
]

test("matchGatedAction matches by namespace:action", () => {
  expect(matchGatedAction("deploy:go:42", actions)?.action).toBe("go")
  expect(matchGatedAction("fix:cancel:job-3", actions)?.namespace).toBe("fix")
  expect(matchGatedAction("triage:fixnow:T1", actions)).toBeNull()
  expect(matchGatedAction("not-a-customid", actions)).toBeNull()
})

test("gatedActionArg extracts the arg segment (may contain colons)", () => {
  expect(gatedActionArg("deploy:go:42")).toBe("42")
  expect(gatedActionArg("fix:cancel:job-3")).toBe("job-3")
  expect(gatedActionArg("a:b:c:d")).toBe("c:d")
  expect(gatedActionArg("garbage")).toBe("")
})

test("requiresApprover reflects the matched action's flag", () => {
  expect(requiresApprover("deploy:go:42", actions)).toBe(true)
  expect(requiresApprover("fix:cancel:job-3", actions)).toBe(false)
  expect(requiresApprover("triage:x:1", actions)).toBe(false)
})

test("interpolateCommand substitutes $arg", () => {
  expect(interpolateCommand("deploy.sh $arg --yes", "42")).toBe("deploy.sh 42 --yes")
  expect(interpolateCommand("no placeholder", "42")).toBe("no placeholder")
})
