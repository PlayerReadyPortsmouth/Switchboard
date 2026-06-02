import type { AgentConfig, InboundMessage, AgentReply } from "../types"
import type { AgentTransport } from "./index"

export interface HeadlessResult { stdout: string }
export type HeadlessRunner = (
  args: string[], stdin: string, cwd: string, timeoutMs: number,
) => Promise<HeadlessResult>

/** Ephemeral agent: one `claude -p --resume` spawn per turn, isolated per chatKey. */
export class HeadlessTransport implements AgentTransport {
  private sessions = new Map<string, string>()   // chatKey → session_id
  private cb: (r: AgentReply) => void = () => {}

  constructor(
    public readonly name: string,
    private cfg: AgentConfig,
    private run: HeadlessRunner,
    private timeoutMs: number,
  ) {}

  onReply(cb: (r: AgentReply) => void): void { this.cb = cb }
  isAvailable(): boolean { return true }   // spawned on demand; always available

  deliver(chatKey: string, inbound: InboundMessage): void {
    void this.handle(chatKey, inbound)
  }

  private async handle(chatKey: string, inbound: InboundMessage): Promise<void> {
    const args = ["-p", "--output-format", "json"]
    if (this.cfg.runtime.model) args.push("--model", this.cfg.runtime.model)
    if (this.cfg.runtime.allowedTools?.length) {
      args.push("--allowedTools", this.cfg.runtime.allowedTools.join(","))
    }
    if (this.cfg.runtime.appendSystemPrompt) {
      args.push("--append-system-prompt", this.cfg.runtime.appendSystemPrompt)
    }
    const prior = this.sessions.get(chatKey)
    if (prior) args.push("--resume", prior)

    try {
      const { stdout } = await this.run(args, inbound.content, this.cfg.runtime.cwd, this.timeoutMs)
      const parsed = JSON.parse(stdout) as { result?: string; session_id?: string }
      if (parsed.session_id) this.sessions.set(chatKey, parsed.session_id)
      this.cb({ agent: this.name, kind: "reply", chatId: inbound.chatId,
        text: parsed.result ?? "(no output)", replyTo: inbound.messageId })
    } catch (err) {
      this.cb({ agent: this.name, kind: "reply", chatId: inbound.chatId,
        text: `Sorry — I couldn't complete that just now. (${(err as Error).message})`,
        replyTo: inbound.messageId })
    }
  }
}
