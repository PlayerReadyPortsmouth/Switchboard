import { test, expect } from "bun:test"
import { buildAgentEnv, parseEnvFile, ENV_ESSENTIALS } from "./agentEnv"

const hubEnv = { PATH: "/bin", HOME: "/root", XERO_SECRET: "shh", DISCORD_BOT_TOKEN: "tok", NOISE: "x" }
const injected = { HUB_SOCKET: "/sock", AGENT_NAME: "ada" }

test("no spec inherits the whole hub environment — today's behaviour, unchanged", () => {
  const e = buildAgentEnv(undefined, hubEnv, injected)
  expect(e.XERO_SECRET).toBe("shh")
  expect(e.DISCORD_BOT_TOKEN).toBe("tok")
  expect(e.HUB_SOCKET).toBe("/sock")
  expect(e.AGENT_NAME).toBe("ada")
})

test('envPassthrough ["*"] is the same as no spec', () => {
  expect(buildAgentEnv({ envPassthrough: ["*"] }, hubEnv, injected))
    .toEqual(buildAgentEnv(undefined, hubEnv, injected))
})

test("a narrow passthrough keeps essentials and drops the credentials", () => {
  const e = buildAgentEnv({ envPassthrough: ["NOISE"] }, hubEnv, injected)
  expect(e.NOISE).toBe("x")
  expect(e.PATH).toBe("/bin")       // essential, kept without being listed
  expect(e.HOME).toBe("/root")
  expect(e.XERO_SECRET).toBeUndefined()
  expect(e.DISCORD_BOT_TOKEN).toBeUndefined()
})

test("essentials that the hub does not hold are simply absent", () => {
  const e = buildAgentEnv({ envPassthrough: [] }, { PATH: "/bin" }, {})
  expect(e.PATH).toBe("/bin")
  for (const k of ENV_ESSENTIALS.filter((k) => k !== "PATH")) expect(e[k]).toBeUndefined()
})

test("envFile is layered over the passthrough, and inline env over the file", () => {
  const e = buildAgentEnv(
    { envPassthrough: [], envFile: "/agents/ada.env", env: { API_KEY: "inline" } },
    hubEnv, injected,
    () => "API_KEY=fromfile\nOTHER=ok\n",
  )
  expect(e.API_KEY).toBe("inline")
  expect(e.OTHER).toBe("ok")
})

test("hub-injected values always win, so an agent cannot rename itself or move its socket", () => {
  const e = buildAgentEnv(
    { env: { AGENT_NAME: "root", HUB_SOCKET: "/tmp/evil" } },
    hubEnv, injected,
  )
  expect(e.AGENT_NAME).toBe("ada")
  expect(e.HUB_SOCKET).toBe("/sock")
})

test("an unreadable envFile throws rather than silently falling back to the hub environment", () => {
  expect(() => buildAgentEnv(
    { envPassthrough: [], envFile: "/missing.env" },
    hubEnv, injected,
    () => { throw new Error("ENOENT") },
  )).toThrow(/could not be read/)
})

test("parseEnvFile tolerates comments, blanks, export and quotes", () => {
  expect(parseEnvFile([
    "# a comment",
    "",
    "export TOKEN=abc",
    'QUOTED="hello world"',
    "SINGLE='x'",
    "not a pair",
    "SPACED = spaced",
  ].join("\n"))).toEqual({ TOKEN: "abc", QUOTED: "hello world", SINGLE: "x", SPACED: "spaced" })
})
