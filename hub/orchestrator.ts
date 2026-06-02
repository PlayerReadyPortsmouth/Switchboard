import type { AgentRegistry, HubConfig, InboundMessage } from "./types"
import type { RouteDecision } from "./router"
import { permittedAgents } from "./access"
import { chatKey, decideAgent, BindingStore } from "./bindings"
import { parseControlCommand, renderAgentList } from "./gateway"
import { join } from "path"

import type { GateResult } from "./baseGate"

export interface OrchestratorDeps {
  baseGate: (userId: string, chatId: string, isDM: boolean) => GateResult
  resolveRoles: (userId: string) => Promise<string[]>
  route: (msg: string, permitted: { name: string; description: string }[], current: string | null)
    => Promise<RouteDecision | null>
  dispatch: (agent: string, chatKey: string, inbound: InboundMessage) => boolean
  isAvailable: (agent: string) => boolean
  sendPlain: (chatId: string, text: string) => Promise<void>
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

    const roles = await this.deps.resolveRoles(inbound.userId)
    const permitted = permittedAgents(this.reg, roles, inbound.userId)
    const key = chatKey(this.hub.chatKeyScope, inbound.isDM, inbound.chatId, inbound.userId)
    const bound = this.bindings.get(key)?.agent ?? null

    const control = parseControlCommand(inbound.content)
    if (control) { await this.handleControl(control, inbound, key, permitted, bound); return }

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
    this.deps.dispatch(agent, key, inbound)
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
