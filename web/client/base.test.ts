import "./testSetup"
import { expect, test } from "bun:test"
import { readWebBase } from "./base"

function docWith(content: string | null): { querySelector: (selector: string) => Element | null } {
  return {
    querySelector(selector: string) {
      if (selector !== 'meta[name="switchboard-base"]') return null
      if (content === null) return null
      return { getAttribute: (name: string) => (name === "content" ? content : null) } as unknown as Element
    },
  }
}

test("readWebBase returns / when the meta tag is absent", () => {
  expect(readWebBase(docWith(null))).toBe("/")
})

test("readWebBase returns the normalized meta content when present", () => {
  expect(readWebBase(docWith("/switchboard/"))).toBe("/switchboard/")
  expect(readWebBase(docWith("switchboard"))).toBe("/switchboard/")
  expect(readWebBase(docWith("/"))).toBe("/")
})
