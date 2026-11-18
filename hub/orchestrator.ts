import type { AgentRegistry, HubConfig, InboundMessage } from "./types"
import { addressedAgent, type RouteDecision } from "./router"
import { nameProblem, parseNameCommand } from "./assistantNames"
import { permittedAgents } from "./access"
import { chatKey, decideAgent, BindingStore } from "./bindings"
import { parseControlCommand, renderAgentList } from "./gateway"
import { parsePermissionReply } from "./permissions"
import { resolvePinnedAgent, resolveThreadAgent } from "./channelPin"
import { join } from "path"

import type { GateResult } from "./baseGate"

export interface OrchestratorDeps {
  baseGate: (userId: string, chatId: string, isDM: boolean, threadParentId?: string) => GateResult
  /** Resolve a permission reply by code; returns true if the code was a live request. */
  resolvePermission: (code: string, behavior: "allow" | "deny") => boolean
  resolveRoles: (userId: string) => Promise<string[]>
  route: (msg: string, permitted: { name: string; description: string }[], current: string | null)
    => Promise<RouteDecision | null>
  dispatch: (agent: string, chatKey: string, inbound: InboundMessage) => boolean
  /** Route to a per-thread dedicated instance instead of the normal dispatcher.
   *  `ok: true` means delivered (instance existed or was freshly spawned);
   *  `ok: false` carries a reason the caller turns into a user-facing notice. */
  dispatchThread: (agent: string, parentChannelId: string, inbound: InboundMessage, threadWorktreeRepo: string | undefined) =>
    Promise<{ ok: true } | { ok: false; reason: "cap" } | { ok: false; reason: "worktree_error"; error: string }>
  isAvailable: (agent: string) => boolean
  sendPlain: (chatId: string, text: string) => Promise<void>
  /** This person's own names for agents (agent → name). Absent ⇒ naming is off. */
  personalNames?: (userId: string) => Record<string, string>
  setPersonalName?: (userId: string, agent: string, name: string | null) => void
  /** Agents this person holds a live access grant for. Absent ⇒ none. */
  grantedAgents?: (userId: string) => string[]
  /** The person opened a message with the name of an agent they may not use, and a
   *  grant would let them use it here. Absent ⇒ the message is routed as before. */
  offerAccess?: (chatId: string, userId: string, agent: string) => void
  /** What serves this channel on the CANONICAL path, if anything.
   *
   *  `null` ⇒ an ordinary legacy channel, where per-user bindings work exactly as they
   *  always have. Non-null ⇒ the channel has one agent for everyone, bindings are not
   *  consulted for it, and the control commands must say so instead of describing a
   *  binding that will never be read. Absent dep ⇒ everything behaves as before. */
  canonicalChannel?: (chatId: string) => { agent: string; pinned: boolean } | null
  /** Point a canonical channel at a different agent. Only called for a canonical channel
   *  that is NOT pinned, since a pin is an operator decision a chat command must not
   *  silently overwrite. Returns false if the change did not stick. */
  setCanonicalChannelAgent?: (chatId: string, agent: string) => boolean
  /** Optional: enrich the inbound (recent-message context + memory) right before
   *  dispatch. Returns the message to actually deliver. Absent ⇒ deliver as-is. */
  prepareDispatch?: (ctx: {
    agent: string; key: string; inbound: InboundMessage; isSwitch: boolean
    /** The router judged this a long job. Absent when no router ran (pinned channel). */
    big?: boolean
  }) => Promise<InboundMessage>
}

export class Orchestrator {
  private bindings: BindingStore
  constructor(private hub: HubConfig, private reg: AgentRegistry, private deps: OrchestratorDeps) {
    this.bindings = new BindingStore(join(hub.stateDir, "bindings.json"))
  }

  async handleMessage(inbound: InboundMessage): Promise<void> {
    // Layer 0: base pairing/allowlist wall — before any routing.
    const g = this.deps.baseGate(inbound.userId, inbound.chatId, inbound.isDM, inbound.threadParentId)
    // A DM from someone the allowlist does not know, who is nonetheless already allowed an
    // agent that opts in to DMs: let it through. `permittedAgents` below still decides
    // which agents they get, and in a DM that is only the `access.dm` ones.
    const viaAgent = g.action !== "deliver" && inbound.isDM && this.hub.dmViaAgentAccess
      ? await this.mayDmViaAgent(inbound.userId) : false
    if (g.action === "drop" && !viaAgent) return
    if (g.action === "pair" && !viaAgent) {
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
    const permitted = permittedAgents(this.reg, roles, inbound.userId, {
      channelId: inbound.chatId,
      threadParentId: inbound.threadParentId,
      isDM: inbound.isDM,
    }, this.deps.grantedAgents?.(inbound.userId))
    const key = chatKey(this.hub.chatKeyScope, inbound.isDM, inbound.chatId, inbound.userId)
    const bound = this.bindings.get(key)?.agent ?? null

    const control = parseControlCommand(inbound.content)
    if (control) { await this.handleControl(control, inbound, key, permitted, bound); return }

    // `!name Jeeves`: a person's own name for an agent marked nameable. Handled here, by
    // the hub, so no model can be talked into renaming anything.
    const naming = this.deps.personalNames ? parseNameCommand(inbound.content) : null
    if (naming) { await this.handleNaming(naming, inbound, permitted); return }
    // Their names count as addressing the agent: "Jeeves, …" is "Assistant, …".
    const mine = this.deps.personalNames?.(inbound.userId) ?? {}
    const addressed = (list: string[]): string | null => {
      const byOwn = Object.entries(mine).filter(([a]) => list.includes(a))
      const hit = addressedAgent(inbound.content, byOwn.map(([, n]) => n))
      if (hit) return byOwn.find(([, n]) => n === hit)![0]
      return addressedAgent(inbound.content, list)
    }

    // People talking to each other: a guild message that quote-replies to another PERSON
    // is not for an agent, unless it opens with an agent's name. (`quote` is only set for a
    // reply to a non-bot author, so replying to an agent's own message still reaches it.)
    // Silent by design, like a base-gate drop: answering "not for me" in a busy channel is
    // the very noise this exists to remove. Off unless hub.quietOnHumanReply.
    if (this.hub.quietOnHumanReply && !inbound.isDM && inbound.quote
      && !addressed(permitted)) return

    // "Susie, …" from someone who may not use Susie. Sending it to whichever agent the
    // router fancies instead would answer a question they did not ask of that agent, so
    // stop here and offer the access request. Only when a grant would actually work in
    // this place: an agent scoped to other channels is not on offer here.
    if (this.deps.offerAccess && !addressed(permitted)) {
      const wanted = addressedAgent(inbound.content, Object.keys(this.reg))
      if (wanted && permittedAgents(this.reg, roles, inbound.userId, {
        channelId: inbound.chatId, threadParentId: inbound.threadParentId, isDM: inbound.isDM,
      }, [wanted]).includes(wanted)) {
        this.deps.offerAccess(inbound.chatId, inbound.userId, wanted)
        return
      }
    }

    // Per-thread instance: a message inside a Discord thread whose parent is
    // pinned with `threaded: true` gets its own dedicated agent instance,
    // bypassing both the normal channel pin and the router entirely.
    const threadRoute = resolveThreadAgent(inbound.threadParentId, this.hub.channelAgents ?? [], this.hub.threadAgents)
    if (threadRoute && this.reg[threadRoute.agent] && permitted.includes(threadRoute.agent)) {
      const r = await this.deps.dispatchThread(threadRoute.agent, inbound.threadParentId!, inbound, threadRoute.threadWorktreeRepo)
      if (!r.ok) {
        const msg = r.reason === "cap"
          ? `Too many active ${threadRoute.agent} threads on this channel right now — close one first.`
          : `Couldn't start a ${threadRoute.agent} instance for this thread: ${r.error}`
        await this.deps.sendPlain(inbound.chatId, `${this.reg[threadRoute.agent].emoji} ${msg}`)
      }
      return
    }

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
      // The router is told what this person calls an agent, so "ask Jeeves" lands right.
      permitted.map(n => ({
        name: n,
        description: mine[n] ? `${this.reg[n].description} This person calls it "${mine[n]}".` : this.reg[n].description,
      })),
      current,
    )
    // Guard: never honour a router pick outside the caller's permitted set.
    const decision = routed && permitted.includes(routed.agent) ? routed : null
    // A message that opens with a permitted agent's name goes to that agent, whatever the
    // router or the sticky binding would have done. The router still ran, for its `big` call.
    const agent = addressed(permitted) ?? decideAgent({
      current, permitted, decision,
      threshold: this.hub.switchThreshold, defaultAgent: this.hub.defaultAgent,
    })

    if (!this.deps.isAvailable(agent)) {
      await this.deps.sendPlain(inbound.chatId,
        `${this.reg[agent].emoji} ${agent} is offline right now. Try \`!agents\`.`)
      return
    }
    this.bindings.set(key, { agent, sessionId: this.bindings.get(key)?.sessionId, lastActive: Date.parse(inbound.ts) })
    await this.dispatchEnriched(agent, key, inbound, bound !== agent, decision?.big)
  }

  /** True when this person is allowed at least one agent that opts in to DMs. */
  private async mayDmViaAgent(userId: string): Promise<boolean> {
    const roles = await this.deps.resolveRoles(userId)
    return permittedAgents(this.reg, roles, userId, { isDM: true }, this.deps.grantedAgents?.(userId))
      .some(n => this.reg[n]?.access.dm === true)
  }

  private async handleNaming(
    cmd: { name?: string; clear?: boolean }, inbound: InboundMessage, permitted: string[],
  ): Promise<void> {
    const say = (text: string) => this.deps.sendPlain(inbound.chatId, text)
    const nameable = permitted.filter(n => this.reg[n]?.access.nameable)
    if (nameable.length === 0) { await say("There isn't an assistant you can name here."); return }
    const agent = nameable[0]!
    const current = this.deps.personalNames?.(inbound.userId)[agent]
    const tag = `${this.reg[agent]!.emoji} **${agent}**`
    if (cmd.clear) {
      this.deps.setPersonalName?.(inbound.userId, agent, null)
      await say(current ? `${tag} · Done. I'm no longer "${current}" to you; call me ${agent}.` : `${tag} · You hadn't given me a name.`)
      return
    }
    if (!cmd.name) {
      await say(current
        ? `${tag} · You call me **${current}**. Change it with \`!name <new name>\`, or \`!name clear\`.`
        : `${tag} · You haven't named me yet. Try \`!name Jeeves\`.`)
      return
    }
    const problem = nameProblem(cmd.name, Object.keys(this.reg))
    if (problem) { await say(`${tag} · ${problem}`); return }
    this.deps.setPersonalName?.(inbound.userId, agent, cmd.name.trim())
    await say(`${this.reg[agent]!.emoji} **${cmd.name.trim()} (${agent})** · Done. I'm **${cmd.name.trim()}** to you from now on. Start a message with my name and it comes to me.`)
  }

  /** Dispatch after an optional context/memory enrichment pass. `isSwitch` is
   *  true when this turn changed (or freshly bound) the agent — the signal the
   *  `onSwitch` injection policy keys off, so a newly-bound agent gets caught up. */
  private async dispatchEnriched(
    agent: string, key: string, inbound: InboundMessage, isSwitch: boolean, big?: boolean,
  ): Promise<void> {
    const toSend = this.deps.prepareDispatch
      ? await this.deps.prepareDispatch({ agent, key, inbound, isSwitch, big })
      : inbound
    this.deps.dispatch(agent, key, toSend)
  }

  private async handleControl(
    c: ReturnType<typeof parseControlCommand> & object,
    inbound: InboundMessage, key: string, permitted: string[], bound: string | null,
  ): Promise<void> {
    // A canonical channel has ONE agent for everyone and never reads a binding, so every
    // answer below has to be about the channel rather than about this person. Before this,
    // `!switch` wrote a binding nothing would read and replied "Switched to X" while the
    // next ordinary message still went to the channel's agent. A control that acknowledges
    // and then does nothing is worse than one that errors: it is believed once and then
    // quietly disbelieved forever.
    const canonical = this.deps.canonicalChannel?.(inbound.chatId) ?? null
    switch (c.cmd) {
      case "agents":
        await this.deps.sendPlain(inbound.chatId, renderAgentList(this.reg, permitted, canonical?.agent ?? bound)); return
      case "who":
        await this.deps.sendPlain(inbound.chatId, canonical
          ? `This channel is served by ${this.reg[canonical.agent]?.emoji ?? ""} **${canonical.agent}**${canonical.pinned ? " (pinned in config)" : ""} — the same agent for everyone here, not a per-person binding.`
          : bound ? `Bound to **${bound}**.` : "Not bound yet."); return
      case "reset":
        this.bindings.clear(key)
        await this.deps.sendPlain(inbound.chatId, canonical
          ? `Nothing to clear here — this channel is served by **${canonical.agent}** for everyone, so there is no per-person binding.`
          : "Cleared. Next message routes fresh."); return
      case "switch": {
        if (!permitted.includes(c.arg)) {
          await this.deps.sendPlain(inbound.chatId, `**${c.arg}** is not available to you.`); return
        }
        if (canonical?.pinned) {
          await this.deps.sendPlain(inbound.chatId,
            `This channel is pinned to **${canonical.agent}** in config, so I can't switch it. An operator needs to change \`channelAgents\`.`)
          return
        }
        if (canonical) {
          if (!this.deps.setCanonicalChannelAgent?.(inbound.chatId, c.arg)) {
            await this.deps.sendPlain(inbound.chatId, `Couldn't switch this channel to **${c.arg}**.`); return
          }
          this.bindings.set(key, { agent: c.arg, lastActive: Date.parse(inbound.ts) })
          await this.deps.sendPlain(inbound.chatId,
            `Switched **this channel** to ${this.reg[c.arg].emoji} **${c.arg}** — that applies to everyone here, not just you.`)
          return
        }
        this.bindings.set(key, { agent: c.arg, lastActive: Date.parse(inbound.ts) })
        await this.deps.sendPlain(inbound.chatId, `Switched to ${this.reg[c.arg].emoji} **${c.arg}**.`); return
      }
    }
  }
}
