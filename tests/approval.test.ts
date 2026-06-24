import { test, expect } from "bun:test"
import {
  ApprovalRegistry,
  renderApprovalCard,
  approvalCustomId,
  parseApprovalCustomId,
} from "../hub/approval"

function harness(ttl = 1000) {
  let now = 0
  let n = 0
  const r = new ApprovalRegistry(() => now, () => `appr-${++n}`, ttl)
  return { r, at: (v: number) => { now = v }, advance: (d: number) => { now += d } }
}

const req = (over: Partial<Parameters<ApprovalRegistry["request"]>[0]> = {}) => ({
  kind: "outbound", target: "deploy-done", actor: "agent:assistant", chat: "c1", summary: "POST → deploy-done", ...over,
})

// ---- ApprovalRegistry ----

test("request parks an entry with a deadline and the held fire closure", () => {
  const h = harness(1000)
  h.at(500)
  let fired = false
  const e = h.r.request(req(), () => { fired = true })
  expect(e.id).toBe("appr-1")
  expect(e.state).toBe("pending")
  expect(e.createdAt).toBe(500)
  expect(e.expiresAt).toBe(1500)
  expect(h.r.pendingCount()).toBe(1)
  expect(h.r.get("appr-1")).toBe(e)
  e.fire()
  expect(fired).toBe(true)
})

test("resolve grants once and is single-shot (second resolve → null)", () => {
  const h = harness()
  const e = h.r.request(req(), () => {})
  const granted = h.r.resolve(e.id, "grant")
  expect(granted?.state).toBe("granted")
  expect(h.r.pendingCount()).toBe(0)
  expect(h.r.resolve(e.id, "grant")).toBeNull()   // can't fire twice
  expect(h.r.resolve(e.id, "deny")).toBeNull()
})

test("resolve deny marks denied; unknown id → null", () => {
  const h = harness()
  const e = h.r.request(req(), () => {})
  expect(h.r.resolve(e.id, "deny")?.state).toBe("denied")
  expect(h.r.resolve("nope", "grant")).toBeNull()
})

test("sweepExpired expires only past-deadline entries", () => {
  const h = harness(1000)
  h.at(0)
  const a = h.r.request(req({ target: "a" }), () => {})
  h.at(600)
  const b = h.r.request(req({ target: "b" }), () => {})   // expires at 1600
  h.at(1200)                                              // a (exp 1000) due, b (exp 1600) not
  const expired = h.r.sweepExpired()
  expect(expired.map((e) => e.id)).toEqual([a.id])
  expect(expired[0].state).toBe("expired")
  expect(h.r.pendingCount()).toBe(1)
  expect(h.r.get(b.id)?.state).toBe("pending")
})

// ---- renderApprovalCard ----

test("a pending card has Approve/Deny buttons with the right customIds", () => {
  const h = harness()
  const e = h.r.request(req(), () => {})
  const card = renderApprovalCard(e)
  expect(card.buttons.map((b) => b.customId)).toEqual([`approval:grant:${e.id}`, `approval:deny:${e.id}`])
  expect(card.buttons.map((b) => b.style)).toEqual(["success", "danger"])
  expect(card.body).toContain("deploy-done")
})

test("terminal cards drop the buttons and restate the outcome", () => {
  const h = harness()
  const e = h.r.request(req(), () => {})
  h.r.resolve(e.id, "grant")
  expect(renderApprovalCard(e).buttons).toEqual([])
  expect(renderApprovalCard(e).title).toContain("Approved")
})

// ---- customId helpers ----

test("approvalCustomId / parseApprovalCustomId round-trip and reject others", () => {
  expect(approvalCustomId("appr-7", "grant")).toBe("approval:grant:appr-7")
  expect(approvalCustomId("appr-7", "deny")).toBe("approval:deny:appr-7")
  expect(parseApprovalCustomId("approval:grant:appr-7")).toEqual({ id: "appr-7", decision: "grant" })
  expect(parseApprovalCustomId("approval:deny:appr-7")).toEqual({ id: "appr-7", decision: "deny" })
  expect(parseApprovalCustomId("deploy:go:42")).toBeNull()
  expect(parseApprovalCustomId("approval:weird:x")).toBeNull()
})

test("the customId matches the gateway notify scheme (ns:action:arg, ns≠perm)", () => {
  const id = approvalCustomId("appr-1", "grant")
  expect(/^([a-z][a-z0-9_]*):([a-z0-9_]+):(.+)$/.test(id)).toBe(true)
  expect(id.startsWith("perm:")).toBe(false)
})
