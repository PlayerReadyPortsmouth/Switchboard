import { expect, test } from "bun:test"
import type { HubConfig } from "../hub/types"
import { createDiscordRuntime, resolveDiscordStartup } from "../hub/config"

test("HubConfig permits web-only startup without a Discord token setting", () => {
  const config = {
    discord: { enabled: false }, guildIds: [], socketPath: "s", stateDir: "d",
    routerModel: "m", switchThreshold: 0.7, defaultAgent: "qa", ephemeralTimeoutMs: 1,
    tagStyle: "prefix", chatKeyScope: "user",
  } satisfies HubConfig
  expect(config.discord.enabled).toBe(false)
})

test("disabled Discord does not read the token environment", () => {
  const reads: string[] = []
  const env = new Proxy({}, { get: (_target, key) => { reads.push(String(key)); return undefined } })
  expect(resolveDiscordStartup({ discord: { enabled: false } }, env)).toEqual({ enabled: false })
  expect(reads).toEqual([])
})

test("Discord defaults enabled and requires its backward-compatible token variable", () => {
  expect(resolveDiscordStartup({}, { DISCORD_BOT_TOKEN: "secret" })).toEqual({ enabled: true, token: "secret" })
  expect(() => resolveDiscordStartup({}, {})).toThrow("missing DISCORD_BOT_TOKEN")
})

test("disabled Discord constructs and registers nothing", () => {
  const calls: string[] = []
  const runtime = createDiscordRuntime({ enabled: false }, () => { calls.push("construct"); return { register: () => calls.push("register") } })
  expect(runtime).toBeUndefined()
  expect(calls).toEqual([])
})
