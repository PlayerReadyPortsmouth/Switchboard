import { test, expect } from "bun:test"
import { mkdtempSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { BaseGate } from "./baseGate"

function gateWithGroups(groups: string[]): BaseGate {
  const dir = mkdtempSync(join(tmpdir(), "basegate-"))
  const path = join(dir, "access.json")
  writeFileSync(path, JSON.stringify({ dmPolicy: "pairing", allowFrom: [], groups, pending: {} }))
  return new BaseGate(path)
}

test("guild message in an opted-in group delivers", () => {
  const gate = gateWithGroups(["chanA"])
  expect(gate.gate("u1", "chanA", false, 0)).toEqual({ action: "deliver" })
})

test("guild message NOT in an opted-in group drops", () => {
  const gate = gateWithGroups(["chanA"])
  expect(gate.gate("u1", "chanZ", false, 0)).toEqual({ action: "drop" })
})

test("a thread message delivers when its PARENT channel is opted in, even though the thread's own id isn't", () => {
  const gate = gateWithGroups(["chanA"])
  expect(gate.gate("u1", "thread123", false, 0, "chanA")).toEqual({ action: "deliver" })
})

test("a thread message still drops when neither its own id nor its parent is opted in", () => {
  const gate = gateWithGroups(["chanA"])
  expect(gate.gate("u1", "thread123", false, 0, "chanZ")).toEqual({ action: "drop" })
})

test("a thread message drops when threadParentId is omitted, even if the thread's own id would coincidentally match nothing", () => {
  const gate = gateWithGroups(["chanA"])
  expect(gate.gate("u1", "thread123", false, 0)).toEqual({ action: "drop" })
})
