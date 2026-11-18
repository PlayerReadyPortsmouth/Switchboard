import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { AssistantNames, displayName, nameProblem, parseNameCommand } from "./assistantNames"

const dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "sb-names-")); dirs.push(d); return join(d, "names.json") }
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

describe("nameProblem", () => {
  const taken = ["Bill", "Susie", "Assistant"]
  test("ordinary names are fine", () => {
    for (const n of ["Jeeves", "Alfred", "R2-D2", "Zoë", "x9"]) expect(nameProblem(n, taken)).toBeNull()
  })
  test("another agent's name is refused, whatever the case", () => {
    expect(nameProblem("bill", taken)).toContain("already the name of an agent")
    expect(nameProblem("ASSISTANT", taken)).toContain("already the name of an agent")
  })
  test("words that open ordinary sentences are refused", () => {
    expect(nameProblem("Hey", taken)).toContain("too common")
    expect(nameProblem("what", taken)).toContain("too common")
  })
  test("anything but one short word is refused", () => {
    for (const n of ["", "J", "two words", "x".repeat(25), "<@123>", "a/b", "Jeeves!"]) expect(nameProblem(n, taken)).toContain("one word")
  })
})

describe("parseNameCommand", () => {
  test("recognises the three forms", () => {
    expect(parseNameCommand("!name")).toEqual({})
    expect(parseNameCommand("  !name Jeeves ")).toEqual({ name: "Jeeves" })
    expect(parseNameCommand("!NAME clear")).toEqual({ clear: true })
  })
  test("anything else is not this command", () => {
    expect(parseNameCommand("name Jeeves")).toBeNull()
    expect(parseNameCommand("!named Jeeves")).toBeNull()
    expect(parseNameCommand("call yourself Jeeves")).toBeNull()
  })
})

describe("AssistantNames", () => {
  test("a name belongs to one person and one agent", () => {
    const n = new AssistantNames(tmp())
    n.set("aurora", "Assistant", "Jeeves")
    n.set("stephen", "Assistant", "Alfred")
    expect(n.get("aurora", "Assistant")).toBe("Jeeves")
    expect(n.get("stephen", "Assistant")).toBe("Alfred")
    expect(n.get("aurora", "Bill")).toBeUndefined()
    expect(n.forUser("aurora")).toEqual({ Assistant: "Jeeves" })
    expect(n.forUser("nobody")).toEqual({})
  })
  test("renaming replaces, clearing removes, and both survive a restart", () => {
    const p = tmp()
    const n = new AssistantNames(p)
    n.set("aurora", "Assistant", "Jeeves")
    n.set("aurora", "Assistant", "Hal")
    expect(new AssistantNames(p).get("aurora", "Assistant")).toBe("Hal")
    expect(n.clear("aurora", "Assistant")).toBe(true)
    expect(n.clear("aurora", "Assistant")).toBe(false)
    expect(new AssistantNames(p).forUser("aurora")).toEqual({})
  })
  test("a corrupt file names nothing", () => {
    const p = tmp()
    writeFileSync(p, "[oops")
    expect(new AssistantNames(p).forUser("aurora")).toEqual({})
    writeFileSync(p, JSON.stringify({ aurora: { Assistant: 7 }, stephen: "x" }))
    expect(new AssistantNames(p).forUser("aurora")).toEqual({})
  })
})

test("displayName", () => {
  expect(displayName("Assistant", "Jeeves")).toBe("Jeeves (Assistant)")
  expect(displayName("Bill", undefined)).toBe("Bill")
})
