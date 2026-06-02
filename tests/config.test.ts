import { test, expect } from "bun:test"
import { loadConfigs, expandHome } from "../hub/config"
import { mkdtempSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

test("expandHome resolves a leading ~", () => {
  expect(expandHome("~/x").startsWith("/")).toBe(true)
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
