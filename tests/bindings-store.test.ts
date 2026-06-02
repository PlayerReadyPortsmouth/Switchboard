import { test, expect } from "bun:test"
import { BindingStore } from "../hub/bindings"
import { mkdtempSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

test("set persists and reloads", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-"))
  const path = join(dir, "bindings.json")
  const a = new BindingStore(path)
  a.set("dm:u1", { agent: "research", lastActive: 1 })
  const b = new BindingStore(path)
  expect(b.get("dm:u1")?.agent).toBe("research")
})

test("clear removes a binding across reloads", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-"))
  const path = join(dir, "bindings.json")
  const a = new BindingStore(path)
  a.set("dm:u1", { agent: "qa", lastActive: 1 })
  a.clear("dm:u1")
  expect(new BindingStore(path).get("dm:u1")).toBeUndefined()
})
