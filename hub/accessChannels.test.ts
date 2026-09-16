import { test, expect } from "bun:test"
import { permittedAgents } from "./access"
import type { AgentRegistry, AgentAccess } from "./types"

const reg = (access: Record<string, AgentAccess>): AgentRegistry =>
  Object.fromEntries(Object.entries(access).map(([name, a]) => [name, { access: a } as any])) as AgentRegistry

const DEV = "chan-dev", GEN = "chan-gen", USER = "u1"

test("an agent with no channels is reachable anywhere, as before", () => {
  const r = reg({ open: { roles: ["*"] } })
  expect(permittedAgents(r, [], USER, { channelId: GEN })).toEqual(["open"])
  expect(permittedAgents(r, [], USER, { isDM: true })).toEqual(["open"])
  expect(permittedAgents(r, [], USER)).toEqual(["open"])
})

test("a channel-locked agent appears only in its channel", () => {
  const r = reg({ dev: { roles: ["*"], channels: [DEV] } })
  expect(permittedAgents(r, [], USER, { channelId: DEV })).toEqual(["dev"])
  expect(permittedAgents(r, [], USER, { channelId: GEN })).toEqual([])
})

test("a thread counts as its parent channel", () => {
  const r = reg({ dev: { roles: ["*"], channels: [DEV] } })
  expect(permittedAgents(r, [], USER, { channelId: "thread-1", threadParentId: DEV })).toEqual(["dev"])
  expect(permittedAgents(r, [], USER, { channelId: "thread-1", threadParentId: GEN })).toEqual([])
})

test("a channel-locked agent is not reachable by DM", () => {
  // The point of locking dev tools to a room is that they are not available outside it.
  const r = reg({ dev: { roles: ["*"], channels: [DEV] } })
  expect(permittedAgents(r, [], USER, { isDM: true, channelId: "dm-1" })).toEqual([])
})

test("it fails closed when no context is supplied", () => {
  const r = reg({ dev: { roles: ["*"], channels: [DEV] } })
  expect(permittedAgents(r, [], USER)).toEqual([])
})

test("channels NARROW and never grant", () => {
  // Someone the roles/users check already rejects stays rejected, whatever the channel says.
  const r = reg({ dev: { roles: ["admin"], users: ["someone-else"], channels: [DEV] } })
  expect(permittedAgents(r, [], USER, { channelId: DEV })).toEqual([])
  expect(permittedAgents(r, ["admin"], USER, { channelId: DEV })).toEqual(["dev"])
})

test("an empty channels array does not lock the agent", () => {
  // [] is "no restriction expressed", not "reachable nowhere" — a config that locks an
  // agent out of every channel would be silently useless and hard to spot.
  const r = reg({ dev: { roles: ["*"], channels: [] } })
  expect(permittedAgents(r, [], USER, { channelId: GEN })).toEqual(["dev"])
})

test("a mixed registry returns only what is reachable here", () => {
  const r = reg({
    general: { roles: ["*"] },
    dev: { roles: ["*"], channels: [DEV] },
    qa: { roles: [], users: [USER], channels: [GEN] },
  })
  expect(permittedAgents(r, [], USER, { channelId: GEN }).sort()).toEqual(["general", "qa"])
  expect(permittedAgents(r, [], USER, { channelId: DEV }).sort()).toEqual(["dev", "general"])
})
