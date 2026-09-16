import { test, expect } from "bun:test"
import { mkdtempSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { BaseGate } from "../hub/baseGate"
import type { GateResult } from "../hub/baseGate"
import { admitsSurfaceEvent } from "../hub/surfaces/surfaceGate"
import type { NormalizedSurfaceEvent } from "../hub/surfaces/types"

function event(over: Partial<NormalizedSurfaceEvent> = {}): NormalizedSurfaceEvent {
  return {
    adapter: "discord",
    eventId: "m1",
    externalLocationId: "chanZ",
    externalMessageId: "m1",
    authorId: "u1",
    authorName: "ada",
    content: "six seven",
    createdAt: 0,
    ...over,
  }
}

function realGate(groups: string[], allowFrom: string[] = []): BaseGate {
  const dir = mkdtempSync(join(tmpdir(), "surfacegate-"))
  const path = join(dir, "access.json")
  writeFileSync(path, JSON.stringify({ dmPolicy: "pairing", allowFrom, groups, pending: {} }))
  return new BaseGate(path)
}

const stub = (r: GateResult) => () => r

test("deliver admits the event", () => {
  expect(admitsSurfaceEvent(event(), stub({ action: "deliver" }))).toBe(true)
})

test("drop refuses the event", () => {
  expect(admitsSurfaceEvent(event(), stub({ action: "drop" }))).toBe(false)
})

test("pair refuses too — a pairing code is an answer, not a permission", () => {
  expect(admitsSurfaceEvent(event(), stub({ action: "pair", code: "abc123" }))).toBe(false)
})

test("the gate is asked about the event's OWN location and author", () => {
  const seen: unknown[] = []
  admitsSurfaceEvent(event({ authorId: "u9", externalLocationId: "chanQ" }), (...args) => {
    seen.push(args)
    return { action: "deliver" }
  })
  expect(seen).toEqual([["u9", "chanQ", false, undefined]])
})

test("a thread's parent channel id reaches the gate, so a thread under an opted-in channel is admitted", () => {
  const seen: unknown[] = []
  admitsSurfaceEvent(event({ externalLocationId: "thread123", threadParentId: "chanA" }), (...args) => {
    seen.push(args)
    return { action: "deliver" }
  })
  expect(seen).toEqual([["u1", "thread123", false, "chanA"]])
})

test("isDM is passed as a real boolean when the adapter omits it", () => {
  const seen: unknown[] = []
  admitsSurfaceEvent(event(), (...args) => { seen.push(args); return { action: "deliver" } })
  expect(seen).toEqual([["u1", "chanZ", false, undefined]])
})

// The regression this file exists for: a channel absent from groups[] must be
// refused on the canonical path, exactly as it already was on the legacy one.
test("REGRESSION: a guild channel absent from groups[] is refused by the real gate", () => {
  const gate = realGate(["chanA"])
  const admits = admitsSurfaceEvent(event({ externalLocationId: "chanZ" }),
    (u, c, d, t) => gate.gate(u, c, d, Date.now(), t))
  expect(admits).toBe(false)
})

test("REGRESSION: a guild channel present in groups[] is still admitted", () => {
  const gate = realGate(["chanA"])
  const admits = admitsSurfaceEvent(event({ externalLocationId: "chanA" }),
    (u, c, d, t) => gate.gate(u, c, d, Date.now(), t))
  expect(admits).toBe(true)
})

test("REGRESSION: a thread under an opted-in parent is admitted by the real gate", () => {
  const gate = realGate(["chanA"])
  const admits = admitsSurfaceEvent(event({ externalLocationId: "thread123", threadParentId: "chanA" }),
    (u, c, d, t) => gate.gate(u, c, d, Date.now(), t))
  expect(admits).toBe(true)
})

test("a DM from an unpaired sender is refused (the gate answers `pair`)", () => {
  const gate = realGate([])
  const admits = admitsSurfaceEvent(event({ isDM: true, externalLocationId: "dm1" }),
    (u, c, d, t) => gate.gate(u, c, d, Date.now(), t))
  expect(admits).toBe(false)
})

test("a DM from an allowlisted sender is admitted", () => {
  const gate = realGate([], ["u1"])
  const admits = admitsSurfaceEvent(event({ isDM: true, externalLocationId: "dm1" }),
    (u, c, d, t) => gate.gate(u, c, d, Date.now(), t))
  expect(admits).toBe(true)
})
