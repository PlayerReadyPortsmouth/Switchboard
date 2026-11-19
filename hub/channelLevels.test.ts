import { describe, expect, test } from "bun:test"
import { channelLevel, mustGoPrivate, toolLevel } from "./channelLevels"

const cfg = { channels: { staff: "sensitive", directors: "confidential" } } as const

describe("channel levels", () => {
  test("not configured keeps the old rule: always private", () => {
    expect(mustGoPrivate(undefined, { channelId: "x", tool: "knowledge" })).toBe(true)
  })
  test("an unmarked channel is public, so work records go by DM", () => {
    expect(channelLevel(cfg, "random")).toBe("public")
    expect(mustGoPrivate(cfg, { channelId: "random", tool: "tickets" })).toBe(true)
    expect(mustGoPrivate(cfg, { channelId: "random", tool: "knowledge" })).toBe(false)
  })
  test("a sensitive channel may hear work records but not pay", () => {
    expect(mustGoPrivate(cfg, { channelId: "staff", tool: "tickets" })).toBe(false)
    expect(mustGoPrivate(cfg, { channelId: "staff", tool: "myhours" })).toBe(true)
    expect(mustGoPrivate(cfg, { channelId: "staff", tool: "finance" })).toBe(true)
  })
  test("a confidential channel may hear pay and finance", () => {
    expect(mustGoPrivate(cfg, { channelId: "directors", tool: "finance" })).toBe(false)
  })
  test("a single record in detail is always private", () => {
    expect(mustGoPrivate(cfg, { channelId: "directors", tool: "tickets", detail: true })).toBe(true)
  })
  test("a thread takes its parent's level", () => {
    expect(mustGoPrivate(cfg, { channelId: "thread1", parentId: "staff", tool: "tickets" })).toBe(false)
  })
  test("config overrides the built-in tool table; junk values are ignored", () => {
    expect(toolLevel({ tools: { tickets: "confidential" } }, "tickets")).toBe("confidential")
    expect(toolLevel({ tools: { tickets: "secret" as any } }, "tickets")).toBe("sensitive")
    expect(toolLevel({ defaultTool: "confidential" }, "somethingnew")).toBe("confidential")
    expect(channelLevel({ channels: { a: "nope" as any } }, "a")).toBe("public")
  })
})
