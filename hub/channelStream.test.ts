// hub/channelStream.test.ts
import { test, expect } from "bun:test"
import { ChannelStream } from "./channelStream"

test("publish fans out to subscribers of that channel only", () => {
  const cs = new ChannelStream()
  const seenA: string[] = []
  const seenB: string[] = []
  cs.subscribe("chan-a", (e) => seenA.push(e.content))
  cs.subscribe("chan-b", (e) => seenB.push(e.content))
  cs.publish("chan-a", { ts: 1, author: "x", content: "hi", origin: "discord" })
  expect(seenA).toEqual(["hi"])
  expect(seenB).toEqual([])
})

test("unsubscribe stops delivery", () => {
  const cs = new ChannelStream()
  const seen: string[] = []
  const unsub = cs.subscribe("chan-a", (e) => seen.push(e.content))
  unsub()
  cs.publish("chan-a", { ts: 1, author: "x", content: "hi", origin: "discord" })
  expect(seen).toEqual([])
})

test("publish with no subscribers is a no-op", () => {
  const cs = new ChannelStream()
  expect(() => cs.publish("chan-z", { ts: 1, author: "x", content: "hi", origin: "web" })).not.toThrow()
})
