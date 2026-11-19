import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildDiagnosePrompt, diagnoseAgent, parseDiagnosis, renderReport, runLearner } from "./learnerDiagnose"
import type { Miss } from "./learner"

const T = 1_795_000_000_000
const miss: Miss = { ts: T, kind: "tool_not_allowed", agent: "Assistant", tool: "finance", reason: "not_in_agent_scope", userText: "what did I earn?" }

test("the prompt carries the allow list, the instructions and each miss", () => {
  const { system, user } = buildDiagnosePrompt("Assistant", [miss], { prompt: "Be brief.", reads: ["tickets"], actions: [] })
  expect(system).toContain("ONLY JSON")
  expect(system).toContain("Never propose anything that weakens a safety rule")
  expect(user).toContain("reads: tickets")
  expect(user).toContain("Be brief.")
  expect(user).toContain('tool_not_allowed tool=finance reason=not_in_agent_scope | person: "what did I earn?"')
})

describe("parseDiagnosis", () => {
  test("keeps valid proposals and drops malformed ones", () => {
    const raw = 'Here you go:\n{"proposals":[' +
      '{"type":"prompt_edit","summary":"Use mysessionstoday first","why":"two rephrases","text":"For next session, call mysessionstoday.","evidence":2},' +
      '{"type":"prompt_edit","summary":"no wording"},' +
      '{"type":"allow_tool","summary":"Allow rota","tool":"rota"},' +
      '{"type":"allow_tool","summary":"no tool named"},' +
      '{"type":"delete_everything","summary":"x"},' +
      '{"type":"no_change","summary":"Right to refuse pay","evidence":0}]}'
    const p = parseDiagnosis("Assistant", raw)!
    expect(p.map(x => [x.type, x.evidence])).toEqual([["prompt_edit", 2], ["allow_tool", 1], ["no_change", 1]])
    expect(p[0]).toMatchObject({ agent: "Assistant", text: "For next session, call mysessionstoday." })
    expect(p[1]!.tool).toBe("rota")
  })
  test("unparseable output is null, and at most six survive", () => {
    expect(parseDiagnosis("A", "sorry")).toBeNull()
    expect(parseDiagnosis("A", '{"other":1}')).toBeNull()
    const many = JSON.stringify({ proposals: Array.from({ length: 9 }, (_, i) => ({ type: "no_change", summary: `s${i}` })) })
    expect(parseDiagnosis("A", many)).toHaveLength(6)
  })
})

test("diagnoseAgent: no misses needs no model; a failing model gives null", async () => {
  let calls = 0
  expect(await diagnoseAgent("A", [], {}, async () => { calls++; return "" }, "m")).toEqual([])
  expect(calls).toBe(0)
  expect(await diagnoseAgent("A", [miss], {}, async () => { throw new Error("down") }, "m")).toBeNull()
})

test("runLearner collects, diagnoses known agents only, and writes its report", async () => {
  const dir = mkdtempSync(join(tmpdir(), "learner-"))
  mkdirSync(join(dir, "cache"))
  writeFileSync(join(dir, "audit.jsonl"), [
    { ts: T, kind: "access", actor: "user:u1", action: "readyapp.read", outcome: "deny", target: "finance", detail: { agent: "Assistant", reason: "not_in_agent_scope" } },
    { ts: T, kind: "consult", actor: "agent:Ghost", action: "ask", outcome: "deny", target: "Susie", detail: { reason: "caller_not_permitted" } },
  ].map(r => JSON.stringify(r)).join("\n") + "\n")
  const asked: string[] = []
  const report = await runLearner({
    stateDir: dir, model: "m", now: () => T + 1000,
    contextFor: (a) => (a === "Assistant" ? { prompt: "p" } : undefined),
    run: async (_args, stdin) => { asked.push(stdin.split("\n")[0]!); return '{"proposals":[{"type":"no_change","summary":"Pay is rightly off for this agent","evidence":1}]}' },
  })
  expect(asked).toEqual(["Agent: Assistant"])
  expect(report.findings.map(f => f.agent).sort()).toEqual(["Assistant", "Ghost"])
  expect(report.proposals).toHaveLength(1)
  const md = readFileSync(join(dir, "learner", "latest.md"), "utf8")
  expect(md).toContain("Nothing below has been applied.")
  expect(md).toContain("Pay is rightly off for this agent")
  expect(renderReport(report)).toBe(md)
})

test("runLearner writes nothing when there were no misses", async () => {
  const dir = mkdtempSync(join(tmpdir(), "learner-"))
  const report = await runLearner({ stateDir: dir, model: "m", contextFor: () => ({}), run: async () => "" })
  expect(report.findings).toEqual([])
  expect(existsSync(join(dir, "learner"))).toBe(false)
})
