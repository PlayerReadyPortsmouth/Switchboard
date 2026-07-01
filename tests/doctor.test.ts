import { test, expect } from "bun:test"
import { runDoctor, renderDoctor, type DoctorFacts } from "../hub/doctor"

const base: DoctorFacts = {
  agents: [{ name: "ori", alive: true, registered: true }],
  stateDirWritable: true,
  pendingApprovals: 0,
  auditEnabled: true,
  traceEnabled: true,
  routerModel: "claude-haiku",
}

test("a fully healthy hub reports ok overall", () => {
  const r = runDoctor(base)
  expect(r.status).toBe("ok")
  expect(r.checks.every((c) => c.status === "ok")).toBe(true)
})

test("an agent that registered but is not alive is a fail", () => {
  const r = runDoctor({ ...base, agents: [{ name: "ori", alive: false, registered: true }] })
  expect(r.status).toBe("fail")
  expect(r.checks.find((c) => c.name.includes("ori"))?.status).toBe("fail")
})

test("an agent that never registered is a warn, not a fail", () => {
  const r = runDoctor({ ...base, agents: [{ name: "ori", alive: false, registered: false }] })
  expect(r.status).toBe("warn")
  expect(r.checks.find((c) => c.name.includes("ori"))?.status).toBe("warn")
})

test("a non-writable state dir is a fail", () => {
  const r = runDoctor({ ...base, stateDirWritable: false })
  expect(r.status).toBe("fail")
  expect(r.checks.find((c) => c.name.includes("state"))?.status).toBe("fail")
})

test("a missing router model is a warn", () => {
  const r = runDoctor({ ...base, routerModel: undefined })
  expect(r.status).toBe("warn")
})

test("audit/trace being off is informational, not a failure", () => {
  const r = runDoctor({ ...base, auditEnabled: false, traceEnabled: false })
  expect(r.status).toBe("ok")
})

test("overall status is the worst individual check", () => {
  const r = runDoctor({ ...base, stateDirWritable: false, routerModel: undefined })
  expect(r.status).toBe("fail")   // fail beats warn
})

test("renderDoctor shows an overall header and one line per check", () => {
  const out = renderDoctor(runDoctor(base))
  expect(out).toContain("doctor")
  expect(out.split("\n").length).toBeGreaterThan(base.agents.length)
})
