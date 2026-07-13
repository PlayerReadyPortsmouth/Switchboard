import { expect, test } from "bun:test"
import { DraftStore, type StorageLike } from "./drafts"

class MemoryStorage implements StorageLike {
  private values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
  removeItem(key: string) { this.values.delete(key) }
}

test("draft writes persist the exact durable shape and retain the key for unchanged text", () => {
  const storage = new MemoryStorage()
  const keys = ["key-1", "key-2"]
  let now = 10
  const drafts = new DraftStore(storage, () => keys.shift()!, () => now++)

  const first = drafts.write("c1", "hello")
  const unchanged = drafts.write("c1", "hello")
  const changed = drafts.write("c1", "hello again")

  expect(first).toEqual({ text: "hello", clientKey: "key-1", updatedAt: 10 })
  expect(unchanged).toEqual({ text: "hello", clientKey: "key-1", updatedAt: 11 })
  expect(changed).toEqual({ text: "hello again", clientKey: "key-2", updatedAt: 12 })
  expect(JSON.parse(storage.getItem("switchboard:draft:c1")!)).toEqual(changed)
})

test("empty text deletes a draft", () => {
  const storage = new MemoryStorage()
  const drafts = new DraftStore(storage, () => "key", () => 1)
  drafts.write("c1", "hello")
  expect(drafts.write("c1", "")).toBeNull()
  expect(drafts.read("c1")).toBeNull()
})

test("markSent clears only the successful draft key", () => {
  const storage = new MemoryStorage()
  const keys = ["old-key", "new-key"]
  const drafts = new DraftStore(storage, () => keys.shift()!, () => 1)
  drafts.write("c1", "hello")
  drafts.write("c1", "new typing")

  expect(drafts.markSent("c1", "old-key")).toBe(false)
  expect(drafts.read("c1")?.clientKey).toBe("new-key")
  expect(drafts.markSent("c1", "new-key")).toBe(true)
  expect(drafts.read("c1")).toBeNull()
})

test("malformed persisted drafts are ignored", () => {
  const storage = new MemoryStorage()
  storage.setItem("switchboard:draft:c1", "not json")
  const drafts = new DraftStore(storage, () => "key", () => 1)
  expect(drafts.read("c1")).toBeNull()
})
