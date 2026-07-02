import { test, expect } from "bun:test"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { ThreadStateStore } from "./threadState"

function tmpStore(): ThreadStateStore {
  const dir = mkdtempSync(join(tmpdir(), "threadstate-"))
  return new ThreadStateStore(join(dir, "thread-agents.json"))
}

test("set/get round-trips a thread state", () => {
  const store = tmpStore()
  store.set("t1", { agentName: "dev-agent", parentChannelId: "chanA", worktreePath: "/tmp/wt1", lastActive: 1000, live: true })
  expect(store.get("t1")?.worktreePath).toBe("/tmp/wt1")
})

test("get returns undefined for an unknown thread", () => {
  const store = tmpStore()
  expect(store.get("nope")).toBeUndefined()
})

test("delete removes the entry", () => {
  const store = tmpStore()
  store.set("t1", { agentName: "dev-agent", parentChannelId: "chanA", worktreePath: "/tmp/wt1", lastActive: 1000, live: true })
  store.delete("t1")
  expect(store.get("t1")).toBeUndefined()
})

test("all returns every stored thread keyed by threadId", () => {
  const store = tmpStore()
  store.set("t1", { agentName: "dev-agent", parentChannelId: "chanA", worktreePath: "/tmp/wt1", lastActive: 1000, live: true })
  store.set("t2", { agentName: "dev-agent", parentChannelId: "chanA", worktreePath: "/tmp/wt2", lastActive: 2000, live: false })
  expect(Object.keys(store.all()).sort()).toEqual(["t1", "t2"])
})

test("persists across instances via the same file", () => {
  const dir = mkdtempSync(join(tmpdir(), "threadstate-"))
  const path = join(dir, "thread-agents.json")
  new ThreadStateStore(path).set("t1", { agentName: "dev-agent", parentChannelId: "chanA", worktreePath: "/tmp/wt1", lastActive: 1000, live: true })
  const reopened = new ThreadStateStore(path)
  expect(reopened.get("t1")?.parentChannelId).toBe("chanA")
})
