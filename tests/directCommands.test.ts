import { test, expect } from "bun:test"
import {
  matchDirectCommand, interpolateArgs, renderTemplate, runDirect,
  type DirectExecutor, type ExecResult,
} from "../hub/directCommands"
import type { DirectCommand } from "../hub/types"

const cmd = (over: Partial<DirectCommand> = {}): DirectCommand =>
  ({ match: "!tb status", exec: { type: "shell", command: "echo hi" }, ...over })

test("matches exact and prefix-with-args, ignores non-matches", () => {
  const cmds = [cmd({ match: "!tb status" }), cmd({ match: "!tb deploy" })]
  expect(matchDirectCommand("!tb status", cmds)?.args).toBe("")
  expect(matchDirectCommand("  !tb deploy api prod ", cmds)).toMatchObject({ args: "api prod" })
  expect(matchDirectCommand("!tb statusfoo", cmds)).toBeNull()   // not a word-boundary prefix
  expect(matchDirectCommand("hello", cmds)).toBeNull()
})

test("interpolateArgs fills $args and $1/$2", () => {
  expect(interpolateArgs("deploy $1 to $2 (all: $args)", "api prod")).toBe("deploy api to prod (all: api prod)")
  expect(interpolateArgs("x $3", "a b")).toBe("x ")   // missing arg → empty
})

test("renderTemplate pulls {{json.path}} and args, blanks missing", () => {
  const result: ExecResult = { text: "{}", json: { state: "green", info: { detail: "ok" } } }
  expect(renderTemplate("**$1**: {{state}} — {{info.detail}} / {{nope}}", result, "API")).toBe("**API**: green — ok / ")
})

const fakeExec = (r: ExecResult): DirectExecutor => async () => r

test("text render: template over JSON, no model", async () => {
  const out = await runDirect(
    cmd({ template: "status={{state}}", render: "text" }),
    "", fakeExec({ text: "{}", json: { state: "green" } }),
  )
  expect(out).toEqual({ kind: "text", text: "status=green" })
})

test("card render uses cardTitle", async () => {
  const out = await runDirect(
    cmd({ render: "card", cardTitle: "Status", template: "{{state}}" }),
    "", fakeExec({ text: "{}", json: { state: "ok" } }),
  )
  expect(out).toEqual({ kind: "card", card: { title: "Status", body: "ok", buttons: [] } })
})

test("no template ⇒ raw exec text", async () => {
  const out = await runDirect(cmd(), "", fakeExec({ text: "raw output" }))
  expect(out).toEqual({ kind: "text", text: "raw output" })
})

test("format bridge hands the raw result to an agent", async () => {
  const out = await runDirect(
    cmd({ formatAgent: "ops", template: "Summarise this status:" }),
    "", fakeExec({ text: "RAW123" }),
  )
  expect(out).toEqual({ kind: "agent", agent: "ops", content: "Summarise this status:\n\nRAW123" })
})
