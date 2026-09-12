import { test, expect } from "bun:test"
import { buildExecVector, validateRunAs } from "./runAs"

test("no runAs leaves the exec vector untouched", () => {
  expect(buildExecVector("claude", ["--model", "x"], undefined, { uid: 0 }))
    .toEqual({ bin: "claude", argv: ["--model", "x"] })
})

test("runAs wraps in setpriv and terminates its own flags with --", () => {
  const v = buildExecVector("claude", ["--model", "x"], { user: "agent-managers" }, { uid: 0 })
  expect(v.bin).toBe("setpriv")
  expect(v.argv).toEqual([
    "--reuid=agent-managers", "--regid=agent-managers", "--init-groups",
    "--", "claude", "--model", "x",
  ])
})

test("an explicit group is used instead of the user's name", () => {
  const v = buildExecVector("codex", [], { user: "ada", group: "agents" }, { uid: 0 })
  expect(v.argv.slice(0, 3)).toEqual(["--reuid=ada", "--regid=agents", "--init-groups"])
})

test("initGroups false drops the supplementary groups flag", () => {
  const v = buildExecVector("claude", [], { user: "ada", initGroups: false }, { uid: 0 })
  expect(v.argv).not.toContain("--init-groups")
  expect(v.argv).toEqual(["--reuid=ada", "--regid=ada", "--", "claude"])
})

test("a non-root hub refuses rather than silently running as the hub user", () => {
  expect(() => buildExecVector("claude", [], { user: "ada" }, { uid: 1000 }))
    .toThrow(/not running as root/)
})

test("validateRunAs rejects anything that is not a plain account name", () => {
  expect(() => validateRunAs({ user: "ada" }, "a")).not.toThrow()
  expect(() => validateRunAs({ user: "ada", group: "agents" }, "a")).not.toThrow()
  expect(() => validateRunAs({ user: "ada; rm -rf /" }, "a")).toThrow(/invalid runtime.runAs.user/)
  expect(() => validateRunAs({ user: "ada", group: "a b" }, "a")).toThrow(/invalid runtime.runAs.group/)
  expect(() => validateRunAs({ user: "" }, "a")).toThrow(/invalid runtime.runAs.user/)
})
