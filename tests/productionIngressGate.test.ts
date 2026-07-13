import { expect, test } from "bun:test"
import { ProductionIngressGate } from "../hub/conversations"

test("production ingress gate admits producers before close and invokes none after close", () => {
  const gate = new ProductionIngressGate()
  const calls: string[] = []
  const effects = { ensure: 0, persist: 0, dispatch: 0 }
  const inbound = (content: string) => gate.tryRun(() => {
    if (!content.startsWith("!")) { effects.ensure++; effects.persist++ }
    effects.dispatch++
  })
  expect(inbound("ordinary").accepted).toBe(true)
  expect(inbound("!command").accepted).toBe(true)
  for (const kind of ["card", "update", "react", "edit", "reply", "attachment", "note", "file"]) {
    expect(gate.tryRun(() => calls.push(kind)).accepted).toBe(true)
  }
  const beforeClose = [...calls]
  const effectsBeforeClose = { ...effects }
  gate.close(); gate.close()
  expect(inbound("ordinary")).toEqual({ accepted: false })
  expect(inbound("!command")).toEqual({ accepted: false })
  for (const kind of ["card", "update", "react", "edit", "reply", "attachment", "note", "file"]) {
    expect(gate.tryRun(() => calls.push(`closed:${kind}`))).toEqual({ accepted: false })
  }
  expect(calls).toEqual(beforeClose)
  expect(effects).toEqual(effectsBeforeClose)
})
