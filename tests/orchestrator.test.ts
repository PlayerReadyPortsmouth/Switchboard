import { test, expect } from "bun:test"
import { Orchestrator } from "../hub/orchestrator"
import type { AgentRegistry, HubConfig, InboundMessage } from "../hub/types"
import type { GateResult } from "../hub/baseGate"

const hub: HubConfig = {
  botTokenEnv: "T", guildIds: [], socketPath: "s", stateDir: "/tmp/sb-test-orch",
  routerModel: "m", switchThreshold: 0.7, defaultAgent: "qa",
  ephemeralTimeoutMs: 1000, tagStyle: "prefix", chatKeyScope: "user",
}
const reg: AgentRegistry = {
  research: { emoji: "🔬", description: "deep dives", mode: "persistent",
    access: { roles: ["dev"] }, runtime: { cwd: "." } },
  qa: { emoji: "💡", description: "quick", mode: "ephemeral",
    access: { roles: ["*"] }, runtime: { cwd: "." } },
}
const dm = (content: string, userId = "u1"): InboundMessage =>
  ({ chatId: "c", messageId: "m", userId, user: "bob", content, ts: "t", isDM: true })

function fakes() {
  const dispatched: { agent: string; chatKey: string }[] = []
  const plain: { chatId: string; text: string }[] = []
  return {
    dispatched, plain,
    deps: {
      baseGate: (_userId: string, _chatId: string, _isDM: boolean): GateResult => ({ action: "deliver" as const }),
      resolveRoles: async (_id: string) => ["dev"],
      route: async () => ({ agent: "research", confidence: 0.9, switch: true }),
      dispatch: (agent: string, chatKey: string) => { dispatched.push({ agent, chatKey }); return true },
      isAvailable: () => true,
      sendPlain: async (chatId: string, text: string) => { plain.push({ chatId, text }) },
    },
  }
}

test("routes a first message to the chosen agent", async () => {
  const f = fakes()
  const o = new Orchestrator(hub, reg, f.deps as any)
  await o.handleMessage(dm("research the X protocol"))
  expect(f.dispatched[0].agent).toBe("research")
})

test("!agents lists permitted agents without dispatching", async () => {
  const f = fakes()
  const o = new Orchestrator(hub, reg, f.deps as any)
  await o.handleMessage(dm("!agents"))
  expect(f.dispatched.length).toBe(0)
  expect(f.plain[0].text).toContain("research")
})

test("a non-permitted user only reaches wildcard agents", async () => {
  const f = fakes()
  f.deps.resolveRoles = async () => []   // no roles
  const o = new Orchestrator(hub, reg, f.deps as any)
  await o.handleMessage(dm("anything"))
  expect(f.dispatched[0].agent).toBe("qa")  // research is dev-gated; falls back to wildcard qa
})

test("!switch to a non-permitted agent is refused", async () => {
  const f = fakes()
  f.deps.resolveRoles = async () => []
  const o = new Orchestrator(hub, reg, f.deps as any)
  await o.handleMessage(dm("!switch research"))
  expect(f.dispatched.length).toBe(0)
  expect(f.plain[0].text.toLowerCase()).toContain("not available")
})

test("an unpaired stranger gets a pairing code and is not dispatched", async () => {
  const f = fakes()
  f.deps.baseGate = () => ({ action: "pair" as const, code: "abc123" })
  const o = new Orchestrator(hub, reg, f.deps as any)
  await o.handleMessage(dm("hello", "stranger"))
  expect(f.dispatched.length).toBe(0)
  expect(f.plain[0].text).toContain("abc123")
})

test("a base-gate drop is silent (no reply, no dispatch)", async () => {
  const f = fakes()
  f.deps.baseGate = () => ({ action: "drop" as const })
  const o = new Orchestrator(hub, reg, f.deps as any)
  await o.handleMessage(dm("hello", "stranger"))
  expect(f.dispatched.length).toBe(0)
  expect(f.plain.length).toBe(0)
})
