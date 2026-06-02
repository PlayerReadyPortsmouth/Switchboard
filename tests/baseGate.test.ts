import { test, expect } from "bun:test"
import { BaseGate } from "../hub/baseGate"
import { mkdtempSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

function gateWith(access: object): { path: string; gate: BaseGate } {
  const dir = mkdtempSync(join(tmpdir(), "sb-gate-"))
  const path = join(dir, "access.json")
  writeFileSync(path, JSON.stringify(access))
  return { path, gate: new BaseGate(path) }
}
const NOW = 1_000_000

test("allowlisted DM sender is delivered", () => {
  const { gate } = gateWith({ dmPolicy: "pairing", allowFrom: ["u1"], groups: [], pending: {} })
  expect(gate.gate("u1", "c", true, NOW)).toEqual({ action: "deliver" })
})

test("unknown DM in pairing mode gets a code", () => {
  const { gate } = gateWith({ dmPolicy: "pairing", allowFrom: [], groups: [], pending: {} })
  const r = gate.gate("u9", "c", true, NOW)
  expect(r.action).toBe("pair")
  if (r.action === "pair") expect(r.code).toMatch(/^[0-9a-f]{6}$/)
})

test("the same sender gets the same pending code back", () => {
  const { gate } = gateWith({ dmPolicy: "pairing", allowFrom: [], groups: [], pending: {} })
  const a = gate.gate("u9", "c", true, NOW)
  const b = gate.gate("u9", "c", true, NOW + 10)
  if (a.action === "pair" && b.action === "pair") expect(b.code).toBe(a.code)
  else throw new Error("expected pair on both")
})

test("unknown DM in allowlist mode is dropped silently", () => {
  const { gate } = gateWith({ dmPolicy: "allowlist", allowFrom: [], groups: [], pending: {} })
  expect(gate.gate("u9", "c", true, NOW)).toEqual({ action: "drop" })
})

test("disabled policy drops everything, even allowlisted", () => {
  const { gate } = gateWith({ dmPolicy: "disabled", allowFrom: ["u1"], groups: [], pending: {} })
  expect(gate.gate("u1", "c", true, NOW)).toEqual({ action: "drop" })
})

test("guild message delivers only for an opted-in channel", () => {
  const { gate } = gateWith({ dmPolicy: "pairing", allowFrom: [], groups: ["chan1"], pending: {} })
  expect(gate.gate("u9", "chan1", false, NOW)).toEqual({ action: "deliver" })
  expect(gate.gate("u9", "chan2", false, NOW)).toEqual({ action: "drop" })
})

test("expired pending codes are pruned (a new code is issued)", () => {
  const { gate } = gateWith({ dmPolicy: "pairing", allowFrom: [],
    groups: [], pending: { dead: { senderId: "u9", chatId: "c", expiresAt: NOW - 1 } } })
  const r = gate.gate("u9", "c", true, NOW)
  if (r.action === "pair") expect(r.code).not.toBe("dead")
  else throw new Error("expected pair")
})

test("listAllowed returns the allowFrom users", () => {
  const { gate } = gateWith({ dmPolicy: "pairing", allowFrom: ["u1", "u2"], groups: [], pending: {} })
  expect(gate.listAllowed().sort()).toEqual(["u1", "u2"])
})

test("approve moves the sender to allowFrom and returns the chat id", () => {
  const { path, gate } = gateWith({ dmPolicy: "pairing", allowFrom: [], groups: [], pending: {} })
  const r = gate.gate("u9", "cX", true, NOW)
  if (r.action !== "pair") throw new Error("expected pair")
  const approved = gate.approve(r.code, NOW)
  expect(approved).toEqual({ senderId: "u9", chatId: "cX" })
  // a fresh gate over the same file now delivers
  expect(new BaseGate(path).gate("u9", "cX", true, NOW)).toEqual({ action: "deliver" })
})
