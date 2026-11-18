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
      baseGate: (_userId: string, _chatId: string, _isDM: boolean, _threadParentId?: string): GateResult => ({ action: "deliver" as const }),
      resolveRoles: async (_id: string) => ["dev"],
      route: async () => ({ agent: "research", confidence: 0.9, switch: true }),
      dispatch: (agent: string, chatKey: string) => { dispatched.push({ agent, chatKey }); return true },
      isAvailable: () => true,
      sendPlain: async (chatId: string, text: string) => { plain.push({ chatId, text }) },
      resolvePermission: (_code: string, _behavior: string) => false,
      dispatchThread: async (_agent: string, _parentChannelId: string, _inbound: InboundMessage, _repo?: string):
        Promise<{ ok: true } | { ok: false; reason: "cap" } | { ok: false; reason: "worktree_error"; error: string }> =>
        ({ ok: true as const }),
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

// --- control commands in a CANONICAL channel ------------------------------------
// A canonical channel has one agent for everyone and never reads a binding, so !switch
// used to write a binding nothing would read and reply "Switched to X" while the next
// ordinary message still went to the channel's agent.
const guild = (content: string, userId = "u1"): InboundMessage =>
  ({ chatId: "chan", messageId: "m", userId, user: "bob", content, ts: "t", isDM: false })

function canonical(f: ReturnType<typeof fakes>, opts: { agent?: string; pinned?: boolean; setOk?: boolean } = {}) {
  const set: { chatId: string; agent: string }[] = []
  ;(f.deps as any).canonicalChannel = () => ({ agent: opts.agent ?? "qa", pinned: opts.pinned ?? false })
  ;(f.deps as any).setCanonicalChannelAgent = (chatId: string, agent: string) => {
    set.push({ chatId, agent }); return opts.setOk ?? true
  }
  return set
}

test("!switch in a LEGACY channel is unchanged", async () => {
  const f = fakes()
  const o = new Orchestrator(hub, reg, f.deps as any)
  await o.handleMessage(guild("!switch research"))
  expect(f.plain[0].text).toContain("Switched to")
  expect(f.plain[0].text).not.toContain("this channel")
})

test("!switch in a canonical channel changes the CHANNEL and says so", async () => {
  const f = fakes()
  const set = canonical(f)
  const o = new Orchestrator(hub, reg, f.deps as any)
  await o.handleMessage(guild("!switch research"))
  expect(set).toEqual([{ chatId: "chan", agent: "research" }])
  expect(f.plain[0].text).toContain("this channel")
  expect(f.plain[0].text).toContain("everyone here")
})

test("REGRESSION: !switch in a canonical channel never claims a per-person switch", async () => {
  const f = fakes()
  canonical(f)
  const o = new Orchestrator(hub, reg, f.deps as any)
  await o.handleMessage(guild("!switch research"))
  // The old reply was exactly this, and it was a lie.
  expect(f.plain[0].text).not.toBe("Switched to 🔬 **research**.")
})

test("!switch refuses on a PINNED channel and does not touch the conversation", async () => {
  const f = fakes()
  const set = canonical(f, { agent: "qa", pinned: true })
  const o = new Orchestrator(hub, reg, f.deps as any)
  await o.handleMessage(guild("!switch research"))
  expect(set).toEqual([])
  expect(f.plain[0].text).toContain("pinned")
  expect(f.plain[0].text).toContain("channelAgents")
  expect(f.plain[0].text).not.toContain("Switched")
})

test("a failed canonical switch reports failure instead of claiming success", async () => {
  const f = fakes()
  canonical(f, { setOk: false })
  const o = new Orchestrator(hub, reg, f.deps as any)
  await o.handleMessage(guild("!switch research"))
  expect(f.plain[0].text).toContain("Couldn't switch")
})

test("!switch to a non-permitted agent is still refused before anything canonical happens", async () => {
  const f = fakes()
  f.deps.resolveRoles = async () => []
  const set = canonical(f)
  const o = new Orchestrator(hub, reg, f.deps as any)
  await o.handleMessage(guild("!switch research"))
  expect(set).toEqual([])
  expect(f.plain[0].text.toLowerCase()).toContain("not available")
})

test("!who in a canonical channel describes the CHANNEL, not a binding", async () => {
  const f = fakes()
  canonical(f, { agent: "research" })
  const o = new Orchestrator(hub, reg, f.deps as any)
  await o.handleMessage(guild("!who"))
  expect(f.plain[0].text).toContain("This channel is served by")
  expect(f.plain[0].text).toContain("research")
  expect(f.plain[0].text).not.toContain("Bound to")
})

test("!who says so when the channel is pinned", async () => {
  const f = fakes()
  canonical(f, { agent: "qa", pinned: true })
  const o = new Orchestrator(hub, reg, f.deps as any)
  await o.handleMessage(guild("!who"))
  expect(f.plain[0].text).toContain("pinned in config")
})

test("!reset in a canonical channel does not promise a fresh route it cannot deliver", async () => {
  const f = fakes()
  canonical(f, { agent: "qa" })
  const o = new Orchestrator(hub, reg, f.deps as any)
  await o.handleMessage(guild("!reset"))
  expect(f.plain[0].text).toContain("Nothing to clear")
  expect(f.plain[0].text).not.toContain("routes fresh")
})

test("!reset in a legacy channel is unchanged", async () => {
  const f = fakes()
  const o = new Orchestrator(hub, reg, f.deps as any)
  await o.handleMessage(guild("!reset"))
  expect(f.plain[0].text).toContain("routes fresh")
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

test("a thread message's threadParentId is passed through to baseGate (so a gate keyed on the parent channel can allow it)", async () => {
  const f = fakes()
  let seenThreadParentId: string | undefined
  f.deps.baseGate = (_userId, _chatId, _isDM, threadParentId) => {
    seenThreadParentId = threadParentId
    return { action: "deliver" as const }
  }
  const o = new Orchestrator(hub, reg, f.deps as any)
  await o.handleMessage({ ...dm("hello"), threadParentId: "parentChan" })
  expect(seenThreadParentId).toBe("parentChan")
})

test("a y/n <code> reply for a known permission resolves it and does not dispatch", async () => {
  const f = fakes()
  const resolved: { code: string; behavior: string }[] = []
  f.deps.resolvePermission = (code: string, behavior: string) => {
    if (code !== "abcde") return false
    resolved.push({ code, behavior }); return true
  }
  const o = new Orchestrator(hub, reg, f.deps as any)
  await o.handleMessage(dm("y abcde"))
  expect(resolved).toEqual([{ code: "abcde", behavior: "allow" }])
  expect(f.dispatched.length).toBe(0)
})

test("a y/n <code> reply for an UNKNOWN code falls through to normal handling", async () => {
  const f = fakes()
  f.deps.resolvePermission = () => false   // unknown code
  const o = new Orchestrator(hub, reg, f.deps as any)
  await o.handleMessage(dm("y zzzzz"))
  expect(f.dispatched.length).toBe(1)      // treated as a normal message → routed
})

test("pinned channel bypasses router and dispatches straight to pinned agent", async () => {
  const pinnedReg: AgentRegistry = {
    ...reg,
    "dev-agent": {
      emoji: "🛠️", description: "dev work", mode: "persistent",
      access: { roles: [], users: ["u1"] }, runtime: { cwd: "." },
    },
  }
  const pinnedHub: HubConfig = {
    ...hub,
    channelAgents: [{ channelId: "pinchan", agent: "dev-agent" }],
  }
  const f = fakes()
  let routeCalled = false
  f.deps.route = async () => { routeCalled = true; return { agent: "research", confidence: 0.9, switch: true } }

  const o = new Orchestrator(pinnedHub, pinnedReg, f.deps as any)
  const msg: InboundMessage = {
    chatId: "pinchan", messageId: "m1", userId: "u1", user: "bob",
    content: "do some dev work", ts: new Date().toISOString(), isDM: false,
  }
  await o.handleMessage(msg)

  expect(f.dispatched.length).toBe(1)
  expect(f.dispatched[0].agent).toBe("dev-agent")
  expect(routeCalled).toBe(false)
})

const devAgentReg: AgentRegistry = {
  ...reg,
  "dev-agent": {
    emoji: "🛠️", description: "dev work", mode: "persistent",
    access: { roles: [], users: ["u1"] }, runtime: { cwd: "." },
  },
}
const threadMsg: InboundMessage = {
  chatId: "thread123", threadParentId: "chanA", messageId: "m1", userId: "u1", user: "alice",
  content: "hi", ts: new Date().toISOString(), isDM: false,
}

test("a thread message under a threaded+pinned channel dispatches via dispatchThread, not dispatch", async () => {
  const threadHub: HubConfig = {
    ...hub,
    channelAgents: [{ channelId: "chanA", agent: "dev-agent", threaded: true }],
    threadAgents: { enabled: true, idleTimeoutMinutes: 60, maxConcurrentInstancesPerChannel: 5 },
  }
  const threadCalls: { agent: string; parentChannelId: string; inbound: InboundMessage; repo: string | undefined }[] = []
  const f = fakes()
  f.deps.dispatchThread = async (agent: string, parentChannelId: string, inbound: InboundMessage, repo?: string) => {
    threadCalls.push({ agent, parentChannelId, inbound, repo })
    return { ok: true as const }
  }
  const o = new Orchestrator(threadHub, devAgentReg, f.deps as any)
  await o.handleMessage(threadMsg)

  expect(threadCalls.length).toBe(1)
  expect(threadCalls[0].agent).toBe("dev-agent")
  expect(threadCalls[0].parentChannelId).toBe("chanA")
  expect(threadCalls[0].inbound.chatId).toBe("thread123")
  expect(threadCalls[0].repo).toBeUndefined()
  expect(f.dispatched.length).toBe(0)
})

test("a thread message under a non-threaded pinned channel falls through to normal dispatch (unchanged)", async () => {
  const threadHub: HubConfig = {
    ...hub,
    channelAgents: [{ channelId: "chanA", agent: "dev-agent" }],
    threadAgents: { enabled: true, idleTimeoutMinutes: 60, maxConcurrentInstancesPerChannel: 5 },
  }
  const threadCalls: unknown[] = []
  const f = fakes()
  f.deps.dispatchThread = async (agent: string, parentChannelId: string, inbound: InboundMessage, repo?: string) => {
    threadCalls.push({ agent, parentChannelId, inbound, repo })
    return { ok: true as const }
  }
  const o = new Orchestrator(threadHub, reg, f.deps as any)
  await o.handleMessage(threadMsg)

  expect(threadCalls.length).toBe(0)
  expect(f.dispatched.length).toBe(1)
})

test("dispatchThread reporting a cap rejection sends the 'too many active threads' notice", async () => {
  const threadHub: HubConfig = {
    ...hub,
    channelAgents: [{ channelId: "chanA", agent: "dev-agent", threaded: true }],
    threadAgents: { enabled: true, idleTimeoutMinutes: 60, maxConcurrentInstancesPerChannel: 1 },
  }
  const f = fakes()
  f.deps.dispatchThread = async () => ({ ok: false as const, reason: "cap" as const })
  const o = new Orchestrator(threadHub, devAgentReg, f.deps as any)
  await o.handleMessage(threadMsg)

  expect(f.dispatched.length).toBe(0)
  expect(f.plain[0].chatId).toBe("thread123")
  expect(f.plain[0].text).toContain("Too many active")
})

test("dispatchThread reporting a worktree_error sends the specific git error, not the cap message", async () => {
  const threadHub: HubConfig = {
    ...hub,
    channelAgents: [{ channelId: "chanA", agent: "dev-agent", threaded: true }],
    threadAgents: { enabled: true, idleTimeoutMinutes: 60, maxConcurrentInstancesPerChannel: 5 },
  }
  const f = fakes()
  f.deps.dispatchThread = async () => ({ ok: false as const, reason: "worktree_error" as const, error: "fatal: disk full" })
  const o = new Orchestrator(threadHub, devAgentReg, f.deps as any)
  await o.handleMessage(threadMsg)

  expect(f.dispatched.length).toBe(0)
  expect(f.plain[0].text).toContain("fatal: disk full")
  expect(f.plain[0].text).not.toContain("Too many active")
})

// ---- quietOnHumanReply + name addressing (18 Nov 2026) ----

const guildMsg = (content: string, extra: Partial<InboundMessage> = {}): InboundMessage =>
  ({ chatId: "100000", messageId: "m", userId: "u1", user: "bob", content, ts: "t", isDM: false, ...extra })

test("quietOnHumanReply: a reply to another person is not dispatched", async () => {
  const f = fakes()
  const o = new Orchestrator({ ...hub, quietOnHumanReply: true }, reg, f.deps as any)
  await o.handleMessage(guildMsg("Worth trying for sure", { quote: { user: "aurora", content: "what do you think?" } }))
  expect(f.dispatched).toEqual([])
  expect(f.plain).toEqual([])
})

test("quietOnHumanReply: a reply to a person that opens with an agent's name still goes to it", async () => {
  const f = fakes()
  const o = new Orchestrator({ ...hub, quietOnHumanReply: true }, reg, f.deps as any)
  await o.handleMessage(guildMsg("research, can you check that?", { quote: { user: "aurora", content: "is it true?" } }))
  expect(f.dispatched.map(d => d.agent)).toEqual(["research"])
})

test("quietOnHumanReply: ordinary messages and DMs are unaffected", async () => {
  const f = fakes()
  const o = new Orchestrator({ ...hub, quietOnHumanReply: true }, reg, f.deps as any)
  await o.handleMessage(guildMsg("what is the plan?"))
  await o.handleMessage({ ...dm("thanks"), quote: { user: "aurora", content: "x" } })
  expect(f.dispatched.length).toBe(2)
})

test("quietOnHumanReply off (default): a reply to a person is dispatched as before", async () => {
  const f = fakes()
  const o = new Orchestrator(hub, reg, f.deps as any)
  await o.handleMessage(guildMsg("Worth trying for sure", { quote: { user: "aurora", content: "what do you think?" } }))
  expect(f.dispatched.length).toBe(1)
})

test("a message that opens with a permitted agent's name overrides the router's pick", async () => {
  const f = fakes()   // the fake router always answers "research"
  const o = new Orchestrator(hub, reg, f.deps as any)
  await o.handleMessage(guildMsg("Hey qa, quick one"))
  expect(f.dispatched.map(d => d.agent)).toEqual(["qa"])
})

// ---- addressing an agent you may not use → access offer (18 Nov 2026) ----

test("opening with the name of an agent you may not use offers access and routes nowhere", async () => {
  const f = fakes()
  const offers: string[] = []
  const deps = { ...f.deps, resolveRoles: async () => [] as string[], offerAccess: (_c: string, _u: string, a: string) => { offers.push(a) } }
  const o = new Orchestrator(hub, reg, deps as any)
  await o.handleMessage(guildMsg("research, dig into this for me"))   // no "dev" role ⇒ not permitted research
  expect(offers).toEqual(["research"])
  expect(f.dispatched).toEqual([])
})

test("no offer when the agent is scoped to other channels, so a grant would not help here", async () => {
  const f = fakes()
  const offers: string[] = []
  const scoped: AgentRegistry = { ...reg, research: { ...reg.research, access: { roles: ["dev"], channels: ["999999"] } } }
  const deps = { ...f.deps, resolveRoles: async () => [] as string[], route: async () => ({ agent: "qa", confidence: 0.9, switch: true }),
    offerAccess: (_c: string, _u: string, a: string) => { offers.push(a) } }
  const o = new Orchestrator(hub, scoped, deps as any)
  await o.handleMessage(guildMsg("research, dig into this for me"))
  expect(offers).toEqual([])
  expect(f.dispatched.map(d => d.agent)).toEqual(["qa"])
})

test("no offer when the person may already use the agent they named", async () => {
  const f = fakes()
  const offers: string[] = []
  const o = new Orchestrator(hub, reg, { ...f.deps, offerAccess: (_c: string, _u: string, a: string) => { offers.push(a) } } as any)
  await o.handleMessage(guildMsg("research, dig into this for me"))
  expect(offers).toEqual([])
  expect(f.dispatched.map(d => d.agent)).toEqual(["research"])
})
