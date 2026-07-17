import { expect, test } from "bun:test"
import { normalizeWebBase } from "./webBase"

test("normalizeWebBase resolves an unset or root base to /", () => {
  expect(normalizeWebBase(undefined)).toBe("/")
  expect(normalizeWebBase("")).toBe("/")
  expect(normalizeWebBase("   ")).toBe("/")
  expect(normalizeWebBase("/")).toBe("/")
  expect(normalizeWebBase("//")).toBe("/")
})

test("normalizeWebBase adds exactly one leading and trailing slash", () => {
  expect(normalizeWebBase("switchboard")).toBe("/switchboard/")
  expect(normalizeWebBase("/switchboard")).toBe("/switchboard/")
  expect(normalizeWebBase("switchboard/")).toBe("/switchboard/")
  expect(normalizeWebBase("/switchboard/")).toBe("/switchboard/")
  expect(normalizeWebBase("/a/b/")).toBe("/a/b/")
  expect(normalizeWebBase("a/b")).toBe("/a/b/")
})

test("normalizeWebBase collapses duplicate slashes at the ends only", () => {
  expect(normalizeWebBase("//switchboard//")).toBe("/switchboard/")
  expect(normalizeWebBase("  /switchboard/  ")).toBe("/switchboard/")
})
