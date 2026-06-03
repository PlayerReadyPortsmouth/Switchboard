import { test, expect } from "bun:test"
import { CardRegistry } from "./cardRegistry"
import type { CardSpec } from "./types"

const card = (buttons: string[]): CardSpec => ({
  title: "T", body: "b", buttons: buttons.map((id) => ({ customId: id, label: id })),
})

test("set/get records a card location keyed by correlationId", () => {
  const r = new CardRegistry()
  r.set("tkt-1", "chan", "msg-1", card(["a:b:1", "a:c:1"]))
  expect(r.get("tkt-1")).toMatchObject({ chatId: "chan", messageId: "msg-1" })
  expect(r.get("nope")).toBeUndefined()
})

test("correlationFor reverse-maps a button to its card", () => {
  const r = new CardRegistry()
  r.set("tkt-1", "chan", "msg-1", card(["a:b:1"]))
  expect(r.correlationFor("a:b:1")).toBe("tkt-1")
  expect(r.correlationFor("missing")).toBeUndefined()
})

test("supersededCustomIds returns old buttons absent from the new set", () => {
  const r = new CardRegistry()
  r.set("tkt-1", "chan", "msg-1", card(["a:b:1", "a:c:1"]))
  expect(r.supersededCustomIds("tkt-1", ["a:c:1", "a:d:1"])).toEqual(["a:b:1"])
  expect(r.supersededCustomIds("unknown", ["x"])).toEqual([])
})

test("re-setting a correlation forgets the old reverse entries", () => {
  const r = new CardRegistry()
  r.set("tkt-1", "chan", "msg-1", card(["a:b:1"]))
  r.set("tkt-1", "chan", "msg-1", card(["a:c:1"]))
  expect(r.correlationFor("a:b:1")).toBeUndefined()
  expect(r.correlationFor("a:c:1")).toBe("tkt-1")
})
