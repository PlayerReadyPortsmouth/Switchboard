import type { AgentReply, CardSpec, GatedAction } from "./types"
import { CardRegistry } from "./cardRegistry"
import { gatedActionArg, interpolateCommand } from "./gatedActions"

export interface CardLifecycleDeps {
  sendCard(chatId: string, card: CardSpec): Promise<string | undefined>
  editCard(chatId: string, messageId: string, card: CardSpec): Promise<void>
  registerButtons(customIds: string[], key: string): void
  forgetButtons(customIds: string[]): void
  registerModals(card: CardSpec): void
  unregisterModals(customIds: string[]): void
  ownerOf(customId: string): string | undefined
  closeTransport(key: string): void
  runCommand(cmd: string): Promise<number>
}

/** The reply/gated-action core, decoupled from discord.js + the transport map
 *  so it can be unit-tested with injected deps. `index.ts` wires the real ones. */
export class CardLifecycle {
  constructor(private registry: CardRegistry, private deps: CardLifecycleDeps) {}

  /** A fresh card posted by an agent → send, register, record. */
  async onCard(reply: AgentReply, key: string): Promise<void> {
    if (!reply.card) return
    const ids = reply.card.buttons.map((b) => b.customId)
    this.deps.registerButtons(ids, key)
    const msgId = await this.deps.sendCard(reply.chatId, reply.card)
    if (msgId && reply.correlationId) {
      this.registry.set(reply.correlationId, reply.chatId, msgId, reply.card)
      this.deps.registerModals(reply.card)
    }
  }

  /** An in-place edit of an existing card (by correlationId). Falls back to a
   *  fresh post if the correlation was never seen. */
  async onUpdate(correlationId: string, chatId: string, card: CardSpec, key: string): Promise<void> {
    const loc = this.registry.get(correlationId)
    const ids = card.buttons.map((b) => b.customId)
    if (!loc) {
      this.deps.registerButtons(ids, key)
      const msgId = await this.deps.sendCard(chatId, card)
      if (msgId) { this.registry.set(correlationId, chatId, msgId, card); this.deps.registerModals(card) }
      return
    }
    const gone = this.registry.supersededCustomIds(correlationId, ids)
    if (gone.length) { this.deps.forgetButtons(gone); this.deps.unregisterModals(gone) }
    this.deps.registerButtons(ids, key)
    this.registry.set(correlationId, loc.chatId, loc.messageId, card)
    this.deps.registerModals(card)
    await this.deps.editCard(loc.chatId, loc.messageId, card)
  }

  /** A clicked button that matches a GatedAction: edit pending → run the
   *  hub-side command → edit success/failure → tear down the owner on success. */
  async runGated(action: GatedAction, customId: string): Promise<void> {
    const arg = gatedActionArg(customId)
    const correlationId = this.registry.correlationFor(customId)
    const loc = correlationId ? this.registry.get(correlationId) : undefined
    // Find the owning agent by scanning all button ids on the card (the clicked
    // button may belong to a different namespace than the agent's cancel button).
    const allIds = loc ? loc.card.buttons.map((b) => b.customId) : [customId]
    const owner = allIds.map((id) => this.deps.ownerOf(id)).find((o) => o !== undefined)
    const editBody = async (text: string) => {
      if (!loc || !correlationId) return
      const next: CardSpec = { ...loc.card, body: interpolateCommand(text, arg), buttons: [] }
      this.registry.set(correlationId, loc.chatId, loc.messageId, next)
      await this.deps.editCard(loc.chatId, loc.messageId, next)
    }
    await editBody(action.pendingText)
    const code = await this.deps.runCommand(interpolateCommand(action.command, arg))
    await editBody(code === 0 ? action.successText : action.failureText)
    if (action.terminateAgent && code === 0 && owner) this.deps.closeTransport(owner)
  }
}
