import { test, expect } from "bun:test"
import { buildDistillerPrompt, parseDistillerOutput, distill, isValidScope } from "../hub/memory/distiller"

test("scope validation accepts the four shapes, rejects others", () => {
  expect(isValidScope("global")).toBe(true)
  expect(isValidScope("users/123")).toBe(true)
  expect(isValidScope("agents/deploy")).toBe(true)
  expect(isValidScope("channels/c1")).toBe(true)
  expect(isValidScope("etc/passwd")).toBe(false)
  expect(isValidScope("users/a/b")).toBe(false)
})

test("prompt includes the conversation and existing titles", () => {
  const { user } = buildDistillerPrompt("[alice] hi\n[help] hello", [{ scope: "global", title: "Runbook" }])
  expect(user).toContain("[alice] hi")
  expect(user).toContain("[global] Runbook")
})

test("parse keeps valid notes, drops bad scope/empty, dedupes", () => {
  const raw = `{"notes":[
    {"scope":"global","title":"A","tags":["t"],"body":"b1"},
    {"scope":"etc","title":"X","body":"b"},
    {"scope":"global","title":"a","body":"dup"},
    {"scope":"users/9","title":"","body":"b"},
    {"scope":"users/9","title":"U","body":"ub"}
  ]}`
  const out = parseDistillerOutput(raw)
  expect(out?.map((u) => `${u.scope}/${u.title}`)).toEqual(["global/A", "users/9/U"])
})

test("parse returns [] for empty notes, null for garbage", () => {
  expect(parseDistillerOutput('{"notes":[]}')).toEqual([])
  expect(parseDistillerOutput("no json")).toBeNull()
  expect(parseDistillerOutput('{"nope":1}')).toBeNull()
})

test("distill returns parsed upserts from the runner", async () => {
  const run = async () => '{"notes":[{"scope":"global","title":"T","body":"B"}]}'
  const out = await distill({ conversation: "x", existing: [] }, run, "m")
  expect(out).toEqual([{ scope: "global", title: "T", tags: [], body: "B" }])
})

test("distill returns [] when the runner throws", async () => {
  const run = async () => { throw new Error("boom") }
  expect(await distill({ conversation: "x", existing: [] }, run, "m")).toEqual([])
})
