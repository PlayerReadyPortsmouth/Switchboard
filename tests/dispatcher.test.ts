import { test, expect } from "bun:test"
import { Dispatcher, type AgentTransport } from "../hub/transports"
import type { InboundMessage, AgentReply } from "../hub/types"

function fakeTransport(name: string, available = true): AgentTransport & { delivered: any[] } {
  const delivered: any[] = []
  let cb: (r: AgentReply) => void = () => {}
  return {
    name, delivered,
    deliver: (chatKey: string, inbound: InboundMessage) => { delivered.push({ chatKey, inbound }) },
    onReply: (c: (r: AgentReply) => void) => { cb = c },
    isAvailable: () => available,
    _emit: (r: AgentReply) => cb(r),
  } as any
}

test("dispatch reports a synchronous transport rejection", () => {
  const research = fakeTransport("research") as any
  research.deliver = () => false
  expect(new Dispatcher([research]).dispatch("research", "c", inbound)).toBe(false)
})

test("turn outcomes propagate and rejected async reply handlers are reported", async () => {
  let reply: any = () => {}; let outcome: any = () => {}; const errors: unknown[] = []
  const transport = {
    name: "research", deliver: () => true, isAvailable: () => true,
    onReply: (cb: any) => { reply = cb }, onTurnOutcome: (cb: any) => { outcome = cb },
  } as any
  const dispatcher = new Dispatcher([transport], error => errors.push(error))
  const outcomes: any[] = []
  dispatcher.onReply(async () => { throw new Error("reply rejected") })
  ;(dispatcher as any).onTurnOutcome((value: any) => outcomes.push(value))
  await reply({ agent: "research", kind: "reply", chatId: "c", messageId: "m", text: "x" }).catch(() => {})
  outcome({ agent: "research", chatId: "c", messageId: "m", state: "completed" })
  expect((errors[0] as Error).message).toBe("reply rejected")
  expect(outcomes).toHaveLength(1)
})

const inbound: InboundMessage = {
  chatId: "c", messageId: "m", userId: "u", user: "bob",
  content: "hi", ts: "t", isDM: true,
}

test("dispatch routes to the named transport", () => {
  const research = fakeTransport("research")
  const d = new Dispatcher([research])
  d.dispatch("research", "dm:u", inbound)
  expect(research.delivered.length).toBe(1)
})

test("dispatch to an unavailable agent reports offline", () => {
  const research = fakeTransport("research", false)
  const d = new Dispatcher([research])
  expect(d.isAvailable("research")).toBe(false)
})

test("replies propagate through the dispatcher callback", () => {
  const research = fakeTransport("research") as any
  const d = new Dispatcher([research])
  const got: AgentReply[] = []
  d.onReply(r => { got.push(r) })
  research._emit({ agent: "research", kind: "reply", chatId: "c", text: "yo" })
  expect(got[0].text).toBe("yo")
})
