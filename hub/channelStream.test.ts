// hub/channelStream.test.ts
import { test, expect } from "bun:test"
import { ChannelStream } from "./channelStream"

test("publish fans out to subscribers of that channel only", () => {
  const cs = new ChannelStream()
  const seenA: string[] = []
  const seenB: string[] = []
  cs.subscribe("chan-a", (e) => { if (e.kind === "chat") seenA.push(e.content) })
  cs.subscribe("chan-b", (e) => { if (e.kind === "chat") seenB.push(e.content) })
  cs.publish("chan-a", { kind: "chat", ts: 1, author: "x", content: "hi", origin: "discord" })
  expect(seenA).toEqual(["hi"])
  expect(seenB).toEqual([])
})

test("unsubscribe stops delivery", () => {
  const cs = new ChannelStream()
  const seen: string[] = []
  const unsub = cs.subscribe("chan-a", (e) => { if (e.kind === "chat") seen.push(e.content) })
  unsub()
  cs.publish("chan-a", { kind: "chat", ts: 1, author: "x", content: "hi", origin: "discord" })
  expect(seen).toEqual([])
})

test("publish with no subscribers is a no-op", () => {
  const cs = new ChannelStream()
  expect(() => cs.publish("chan-z", { kind: "chat", ts: 1, author: "x", content: "hi", origin: "web" })).not.toThrow()
})

test("publishes and delivers a tool_use event through the same channel as chat events", () => {
  const cs = new ChannelStream()
  const seen: unknown[] = []
  cs.subscribe("chan-a", (e) => seen.push(e))
  cs.publish("chan-a", { kind: "tool_use", ts: 1, agent: "qa", tools: [{ id: "t1", name: "Read" }] })
  expect(seen).toEqual([{ kind: "tool_use", ts: 1, agent: "qa", tools: [{ id: "t1", name: "Read" }] }])
})

test("publishes and delivers a tool_result event with error flags", () => {
  const cs = new ChannelStream()
  const seen: unknown[] = []
  cs.subscribe("chan-a", (e) => seen.push(e))
  cs.publish("chan-a", { kind: "tool_result", ts: 1, agent: "qa", results: [{ id: "t1", isError: true }] })
  expect(seen).toEqual([{ kind: "tool_result", ts: 1, agent: "qa", results: [{ id: "t1", isError: true }] }])
})
