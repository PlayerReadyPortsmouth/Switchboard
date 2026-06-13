import type { AgentRegistry, HubConfig, InboundMessage } from "./types"
import type { RouteDecision } from "./router"
import { permittedAgents } from "./access"
import { chatKey, decideAgent, BindingStore } from "./bindings"
import { parseControlCommand, renderAgentList } from "./gateway"
import { parsePermissionReply } from "./permissions"
import { resolvePinnedAgent } from "./channelPin"
import { join } from "path"

import type { GateResult } from "./baseGate"

export interface OrchestratorDeps {
  baseGate: (userId: string, chatId: string, isDM: boolean) => GateResult
  /** Resolve a permission reply by code; returns true if the code was a live request. */
  resolvePermission: (code: string, behavior: "allow" | "deny") => boolean
  resolveRoles: (userId: string) => Promise<string[]>
  route: (msg: string, permitted: { name: string; description: string }[], current: string | null)
    => Promise<RouteDecision | null>
  dispatch: (agent: string, chatKey: string, inbound: InboundMessage) => boolean
  isAvailable: (agent: string) => boolean
  sendPlain: (chatId: string, text: string) => Promise<void>
  /** Optional: enrich the inbound (recent-message context + memory) right before
   *  dispatch. Returns the message to actually deliver. Absent ⇒ deliver as-is. */
  prepareDispatch?: (ctx: {
    agent: string; key: string; inbound: InboundMessage; isSwitch: boolean
  }) => Promise<InboundMessage>
}

export class Orchestrator {
  private bindings: BindingStore
  constructor(private hub: HubConfig, private reg: AgentRegistry, private deps: OrchestratorDeps) {
    this.bindings = new BindingStore(join(hub.stateDir, "bindings.json"))
  }

  async handleMessage(inbound: InboundMessage): Promise<void> {
    // Layer 0: base pairing/allowlist wall — before any routing.
    const g = this.deps.baseGate(inbound.userId, inbound.chatId, inbound.isDM)
    if (g.action === "drop") return
    if (g.action === "pair") {
      await this.deps.sendPlain(inbound.chatId,
        `Pairing required. Share this code with the operator to get access: \`${g.code}\``)
      return
    }

    // Permission text-reply intercept: "y/n <code>" from a paired user. Only
    // consume it if the code maps to a live permission request; otherwise it's
    // ordinary chat and falls through.
    const perm = parsePermissionReply(inbound.content)
    if (perm && this.deps.resolvePermission(perm.code, perm.behavior)) return

    const roles = await this.deps.resolveRoles(inbound.userId)
    const permitted = permittedAgents(this.reg, roles, inbound.userId)
    const key = chatKey(this.hub.chatKeyScope, inbound.isDM, inbound.chatId, inbound.userId)
    const bound = this.bindings.get(key)?.agent ?? null

    const control = parseControlCommand(inbound.content)
    if (control) { await this.handleControl(control, inbound, key, permitted, bound); return }

    // Channel pin: a pinned channel goes straight to its agent, bypassing the router.
    const pinned = resolvePinnedAgent(inbound.chatId, this.hub.channelAgents ?? [])
    if (pinned && this.reg[pinned] && permitted.includes(pinned)) {
      if (!this.deps.isAvailable(pinned)) {
        await this.deps.sendPlain(inbound.chatId, `${this.reg[pinned].emoji} ${pinned} is offline right now.`)
        return
      }
      this.bindings.set(key, { agent: pinned, sessionId: this.bindings.get(key)?.sessionId, lastActive: Date.parse(inbound.ts) })
      await this.dispatchEnriched(pinned, key, inbound, bound !== pinned)
      return
    }

    if (permitted.length === 0) {
      await this.deps.sendPlain(inbound.chatId, "You don't have access to any agents yet.")
      return
    }

    const current = bound && permitted.includes(bound) ? bound : null
    const routed = await this.deps.route(
      inbound.content,
      permitted.map(n => ({ name: n, description: this.reg[n].description })),
      current,
    )
    // Guard: never honour a router pick outside the caller's permitted set.
    const decision = routed && permitted.includes(routed.agent) ? routed : null
    const agent = decideAgent({
      current, permitted, decision,
      threshold: this.hub.switchThreshold, defaultAgent: this.hub.defaultAgent,
    })

    if (!this.deps.isAvailable(agent)) {
      await this.deps.sendPlain(inbound.chatId,
        `${this.reg[agent].emoji} ${agent} is offline right now. Try \`!agents\`.`)
      return
    }
    this.bindings.set(key, { agent, sessionId: this.bindings.get(key)?.sessionId, lastActive: Date.parse(inbound.ts) })
    await this.dispatchEnriched(agent, key, inbound, bound !== agent)
  }

  /** Dispatch after an optional context/memory enrichment pass. `isSwitch` is
   *  true when this turn changed (or freshly bound) the agent — the signal the
   *  `onSwitch` injection policy keys off, so a newly-bound agent gets caught up. */
  private async dispatchEnriched(
    agent: string, key: string, inbound: InboundMessage, isSwitch: boolean,
  ): Promise<void> {
    const toSend = this.deps.prepareDispatch
      ? await this.deps.prepareDispatch({ agent, key, inbound, isSwitch })
      : inbound
    this.deps.dispatch(agent, key, toSend)
  }

  private async handleControl(
    c: ReturnType<typeof parseControlCommand> & object,
    inbound: InboundMessage, key: string, permitted: string[], bound: string | null,
  ): Promise<void> {
    switch (c.cmd) {
      case "agents":
        await this.deps.sendPlain(inbound.chatId, renderAgentList(this.reg, permitted, bound)); return
      case "who":
        await this.deps.sendPlain(inbound.chatId, bound ? `Bound to **${bound}**.` : "Not bound yet."); return
      case "reset":
        this.bindings.clear(key)
        await this.deps.sendPlain(inbound.chatId, "Cleared. Next message routes fresh."); return
      case "switch":
        if (!permitted.includes(c.arg)) {
          await this.deps.sendPlain(inbound.chatId, `**${c.arg}** is not available to you.`); return
        }
        this.bindings.set(key, { agent: c.arg, lastActive: Date.parse(inbound.ts) })
        await this.deps.sendPlain(inbound.chatId, `Switched to ${this.reg[c.arg].emoji} **${c.arg}**.`); return
    }
  }
}
