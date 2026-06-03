import {
  Client, GatewayIntentBits, Partials, ChannelType,
  ButtonBuilder, ButtonStyle, ActionRowBuilder, EmbedBuilder, type Message, type Interaction,
} from "discord.js"
import type { AgentRegistry, InboundMessage, AgentReply, AgentConfig, HubConfig, CardSpec } from "./types"
import { formatOutbound } from "./format"
import { isDeployAuthorized } from "./deployGate"

export type Control =
  | { cmd: "agents"; arg: undefined }
  | { cmd: "who"; arg: undefined }
  | { cmd: "reset"; arg: undefined }
  | { cmd: "switch"; arg: string }

const STYLE: Record<string, ButtonStyle> = {
  primary: ButtonStyle.Primary, secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success, danger: ButtonStyle.Danger,
}

/** Build an embed + (optional) button row, defensively clamped to Discord's
 *  limits so a malformed/oversized agent card can never throw at send time
 *  (empty description, >4096 body, empty button row, etc.). `row` is undefined
 *  when the card has no usable buttons. */
export function buildCardComponents(card: CardSpec): {
  embed: EmbedBuilder; row?: ActionRowBuilder<ButtonBuilder>
} {
  const clip = (s: unknown, n: number) => (typeof s === "string" ? s.slice(0, n) : "")
  const embed = new EmbedBuilder()
  const title = clip(card.title, 256)
  const body = clip(card.body, 4096)
  if (title) embed.setTitle(title)
  if (body) embed.setDescription(body)
  // An embed must carry SOMETHING; if both title and body are empty, give it a body.
  if (!title && !body) embed.setDescription("(no details)")
  const fields = (card.fields ?? [])
    .slice(0, 25)
    .map((f) => ({ name: clip(f.name, 256) || "​", value: clip(f.value, 1024) || "​", inline: f.inline }))
  if (fields.length) embed.addFields(fields)
  if (card.footer) embed.setFooter({ text: clip(card.footer, 2048) })

  const btns = (card.buttons ?? [])
    .filter((b) => b && b.customId && b.label)
    .slice(0, 5)
    .map((b) => {
      const btn = new ButtonBuilder().setCustomId(clip(b.customId, 100)).setLabel(clip(b.label, 80))
        .setStyle(STYLE[b.style ?? "secondary"])
      if (b.emoji) btn.setEmoji(b.emoji)
      return btn
    })
  const row = btns.length
    ? new ActionRowBuilder<ButtonBuilder>().addComponents(...btns)
    : undefined
  return { embed, row }
}

/** A card button customId is `ns:action:arg`. The `perm:` namespace is reserved
 *  for the permission relay and is NOT treated as a card-notify id here. */
export function parseNotifyCustomId(id: string): { ns: string; action: string; arg: string } | null {
  const m = /^([a-z][a-z0-9_]*):([a-z0-9_]+):(.+)$/.exec(id)
  if (!m || m[1] === "perm") return null
  return { ns: m[1]!, action: m[2]!, arg: m[3]! }
}

export function parseControlCommand(text: string): Control | null {
  const m = text.trim().match(/^!(agents|who|reset|switch)(?:\s+(\S+))?$/i)
  if (!m) return null
  const cmd = m[1].toLowerCase() as Control["cmd"]
  if (cmd === "switch") return { cmd, arg: m[2] ?? "" }
  return { cmd, arg: undefined } as Control
}

export function renderAgentList(reg: AgentRegistry, permitted: string[], current: string | null): string {
  const lines = permitted.map(n => {
    const c = reg[n]
    const mark = n === current ? "  ← current" : ""
    return `${c.emoji} ${n} — ${c.description}${mark}`
  })
  return lines.length ? lines.join("\n") : "(no agents available to you)"
}

/** Thin discord.js wrapper. Caller supplies handlers; this owns the client + I/O. */
export class Gateway {
  readonly client: Client
  private onMessage: (m: InboundMessage) => void = () => {}
  private permButtonCb: (requestId: string, behavior: "allow" | "deny") => void = () => {}
  private notifyButtonCb: (customId: string, userId: string) => void = () => {}
  private isAuthorized: (userId: string) => boolean = () => false
  private deployApproverUserId = ""

  setDeployApprover(userId: string): void { this.deployApproverUserId = userId }

  constructor(private cfg: HubConfig, private registry: AgentRegistry) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.DirectMessages, GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,   // role resolution
      ],
      partials: [Partials.Channel],
    })
  }

  handleInbound(cb: (m: InboundMessage) => void): void { this.onMessage = cb }

  /** Called by the hub: which users may answer permission prompts (base-gate allowlist). */
  setPermissionAuthorizer(fn: (userId: string) => boolean): void { this.isAuthorized = fn }
  onPermissionButton(cb: (requestId: string, behavior: "allow" | "deny") => void): void {
    this.permButtonCb = cb
  }
  onNotifyButton(cb: (customId: string, userId: string) => void): void { this.notifyButtonCb = cb }

  /** DM each allowlisted user an Allow/Deny prompt for a tool-permission request. */
  async sendPermissionPrompt(
    userIds: string[], requestId: string, toolName: string,
  ): Promise<void> {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`perm:allow:${requestId}`).setLabel("Allow")
        .setEmoji("✅").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`perm:deny:${requestId}`).setLabel("Deny")
        .setEmoji("❌").setStyle(ButtonStyle.Danger),
    )
    const content = `🔐 Permission request: \`${toolName}\``
    for (const uid of userIds) {
      try {
        const u = await this.client.users.fetch(uid)
        await u.send({ content, components: [row] })
      } catch (e) {
        process.stderr.write(`gateway: permission prompt to ${uid} failed: ${e}\n`)
      }
    }
  }

  /** Resolve a user's roles by looking them up as a member across configured guilds. */
  async resolveRoles(userId: string): Promise<string[]> {
    const roles = new Set<string>()
    for (const gid of this.cfg.guildIds) {
      try {
        const guild = await this.client.guilds.fetch(gid)
        const member = await guild.members.fetch(userId)
        for (const r of member.roles.cache.values()) roles.add(r.name)
      } catch { /* not a member of this guild */ }
    }
    return [...roles]
  }

  async start(token: string): Promise<void> {
    this.client.on("messageCreate", (msg: Message) => {
      if (msg.author.bot) return
      this.onMessage({
        chatId: msg.channelId, messageId: msg.id, userId: msg.author.id,
        user: msg.author.username, content: msg.content,
        ts: msg.createdAt.toISOString(), isDM: msg.channel.type === ChannelType.DM,
        attachments: [...msg.attachments.values()].map(a => ({
          name: a.name ?? a.id, type: a.contentType ?? "unknown", size: a.size })),
      })
    })
    this.client.on("interactionCreate", async (interaction: Interaction) => {
      if (!interaction.isButton()) return
      if (!this.isAuthorized(interaction.user.id)) {
        await interaction.reply({ content: "Not authorized.", ephemeral: true }).catch(() => {})
        return
      }
      const perm = /^perm:(allow|deny):(.+)$/.exec(interaction.customId)
      if (perm) {
        const behavior = perm[1] as "allow" | "deny"
        this.permButtonCb(perm[2]!, behavior)
        const label = behavior === "allow" ? "✅ Allowed" : "❌ Denied"
        await interaction.update({
          content: `${interaction.message.content}\n\n${label}`, components: [],
        }).catch(() => {})
        return
      }
      if (parseNotifyCustomId(interaction.customId)) {
        const okDeploy = isDeployAuthorized(interaction.customId, interaction.user.id, this.deployApproverUserId)
        if (!okDeploy) {
          await interaction.reply({ content: "🔒 Only the deploy approver can deploy to live.", ephemeral: true }).catch(() => {})
          return
        }
        this.notifyButtonCb(interaction.customId, interaction.user.id)
        await interaction.deferUpdate().catch(() => {})  // agent will edit the card to reflect the action
        return
      }
    })
    await this.client.login(token)
  }

  /** Send a tagged, chunked reply for a given agent. */
  async sendReply(reply: AgentReply, agent: AgentConfig): Promise<void> {
    const ch = await this.client.channels.fetch(reply.chatId)
    if (!ch || !("send" in ch)) return
    const chunks = formatOutbound(reply.text ?? "", agent, this.cfg.tagStyle, 2000, "newline", reply.agent)
    for (let i = 0; i < chunks.length; i++) {
      await (ch as any).send({
        content: chunks[i],
        ...(i === 0 && reply.files?.length ? { files: reply.files } : {}),
        ...(i === 0 && reply.replyTo
          ? { reply: { messageReference: reply.replyTo, failIfNotExists: false } } : {}),
      })
    }
  }

  async sendCard(chatId: string, card: CardSpec): Promise<void> {
    const ch = await this.client.channels.fetch(chatId)
    if (!ch || !("send" in ch)) return
    const { embed, row } = buildCardComponents(card)
    await (ch as any).send({ embeds: [embed], components: row ? [row] : [] })
  }

  async sendPlain(chatId: string, text: string): Promise<void> {
    const ch = await this.client.channels.fetch(chatId)
    if (ch && "send" in ch) await (ch as any).send({ content: text })
  }
}
