import { test, expect } from "bun:test"
import { loadConfigs, expandHome } from "../hub/config"
import { mkdtempSync, writeFileSync } from "fs"
import { isAbsolute, join } from "path"
import { tmpdir } from "os"

test("expandHome resolves a leading ~", () => {
  expect(isAbsolute(expandHome("~/x"))).toBe(true)
})

test("loads and validates both files", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-cfg-"))
  writeFileSync(join(dir, "hub.config.json"), JSON.stringify({
    botTokenEnv: "DISCORD_BOT_TOKEN", guildIds: ["g1"], socketPath: "~/.sb/hub.sock",
    stateDir: "~/.sb", routerModel: "claude-haiku-4-5", switchThreshold: 0.7,
    defaultAgent: "qa", ephemeralTimeoutMs: 1000, tagStyle: "prefix", chatKeyScope: "user",
  }))
  writeFileSync(join(dir, "agents.json"), JSON.stringify({
    qa: { emoji: "💡", description: "q", mode: "ephemeral",
      access: { roles: ["*"] }, runtime: { cwd: "." } },
  }))
  const { hub, agents } = loadConfigs(dir)
  expect(hub.defaultAgent).toBe("qa")
  expect(agents.qa.mode).toBe("ephemeral")
})

test("rejects an enabled federation block with a malformed listenAddr", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-cfg-"))
  writeFileSync(join(dir, "hub.config.json"), JSON.stringify({
    botTokenEnv: "T", guildIds: [], socketPath: "s", stateDir: "d",
    routerModel: "m", switchThreshold: 0.7, defaultAgent: "qa",
    ephemeralTimeoutMs: 1, tagStyle: "prefix", chatKeyScope: "user",
    federation: { enabled: true, name: "bravo", listenAddr: "no-port", peers: {} },
  }))
  writeFileSync(join(dir, "agents.json"), JSON.stringify({
    qa: { emoji: "💡", description: "q", mode: "ephemeral", access: { roles: ["*"] }, runtime: { cwd: "." } },
  }))
  expect(() => loadConfigs(dir)).toThrow(/listenAddr/)
})

test("rejects a federation peer missing its authKeyEnv", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-cfg-"))
  writeFileSync(join(dir, "hub.config.json"), JSON.stringify({
    botTokenEnv: "T", guildIds: [], socketPath: "s", stateDir: "d",
    routerModel: "m", switchThreshold: 0.7, defaultAgent: "qa",
    ephemeralTimeoutMs: 1, tagStyle: "prefix", chatKeyScope: "user",
    federation: { enabled: true, name: "bravo", listenAddr: "127.0.0.1:9920", peers: { alpha: { addr: "10.0.0.1:9920" } } },
  }))
  writeFileSync(join(dir, "agents.json"), JSON.stringify({
    qa: { emoji: "💡", description: "q", mode: "ephemeral", access: { roles: ["*"] }, runtime: { cwd: "." } },
  }))
  expect(() => loadConfigs(dir)).toThrow(/authKeyEnv/)
})

test("rejects a defaultAgent missing from the registry", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-cfg-"))
  writeFileSync(join(dir, "hub.config.json"), JSON.stringify({
    botTokenEnv: "T", guildIds: [], socketPath: "s", stateDir: "d",
    routerModel: "m", switchThreshold: 0.7, defaultAgent: "ghost",
    ephemeralTimeoutMs: 1, tagStyle: "prefix", chatKeyScope: "user",
  }))
  writeFileSync(join(dir, "agents.json"), JSON.stringify({
    qa: { emoji: "💡", description: "q", mode: "ephemeral", access: { roles: ["*"] }, runtime: { cwd: "." } },
  }))
  expect(() => loadConfigs(dir)).toThrow(/defaultAgent/)
})
