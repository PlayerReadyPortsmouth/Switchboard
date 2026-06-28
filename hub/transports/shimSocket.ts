import { unlinkSync } from "fs"
import type { Socket } from "bun"
import type { CardSpec } from "../types"
import { LineDecoder, encode } from "../framing"

type Conn = { socket: Socket<unknown>; decoder: LineDecoder }

/** A note an agent asks the hub to remember (scope optional → agent's own). */
export interface RememberMsg { scope?: string; title: string; tags?: string[]; body: string }
/** A note returned to an agent's recall request. */
export interface RecalledNote { title: string; body: string }

/** A Unix-socket server the agent's shim connects to, forwarding tool calls
 *  (post_card / react / edit) from the agent process to the hub. */
export class ShimSocketServer {
  private server?: ReturnType<typeof Bun.listen>
  private registered = false
  private regCb: () => void = () => {}
  private notifyCb: (n: { chatId: string; card: CardSpec; correlationId: string }) => void = () => {}
  private reactCb: (r: { chatId: string; messageId: string; emoji: string }) => void = () => {}
  private editCb: (e: { chatId: string; messageId: string; text: string }) => void = () => {}
  private updateCb: (u: { chatId: string; card: CardSpec; correlationId: string }) => void = () => {}
  private finishCb: () => void = () => {}
  private rememberCb: (r: RememberMsg) => void = () => {}
  private recallCb: (q: { query: string; scopes?: string[] }) => Promise<RecalledNote[]> = async () => []
  private postWebhookCb: (w: { target: string; body?: string }) => void = () => {}
  private askAgentCb: (q: { agent: string; message: string }) => Promise<string> = async () => ""
  private attachCb: (a: { chatId: string; path: string; caption?: string; filename?: string }) => void = () => {}

  constructor(private socketPath: string) {}

  onRegister(cb: () => void) { this.regCb = cb }
  onNotify(cb: typeof this.notifyCb) { this.notifyCb = cb }
  onReact(cb: typeof this.reactCb) { this.reactCb = cb }
  onEdit(cb: typeof this.editCb) { this.editCb = cb }
  onUpdate(cb: typeof this.updateCb) { this.updateCb = cb }
  onFinish(cb: typeof this.finishCb) { this.finishCb = cb }
  onRemember(cb: typeof this.rememberCb) { this.rememberCb = cb }
  onRecall(cb: typeof this.recallCb) { this.recallCb = cb }
  onPostWebhook(cb: typeof this.postWebhookCb) { this.postWebhookCb = cb }
  onAskAgent(cb: typeof this.askAgentCb) { this.askAgentCb = cb }
  onAttach(cb: typeof this.attachCb) { this.attachCb = cb }
  isRegistered() { return this.registered }

  async listen(): Promise<void> {
    try { unlinkSync(this.socketPath) } catch {}
    const self = this
    this.server = Bun.listen({
      unix: this.socketPath,
      socket: {
        open(socket) { (socket as any).__c = { socket, decoder: new LineDecoder() } },
        data(socket, data) {
          const c: Conn = (socket as any).__c
          for (const obj of c.decoder.push(data.toString())) self.dispatch(obj as any, socket)
        },
      },
    })
  }

  private dispatch(m: any, socket: Socket<unknown>): void {
    switch (m.t) {
      case "register": this.registered = true; this.regCb(); break
      case "notify": this.notifyCb({ chatId: m.chatId, card: m.card, correlationId: m.correlationId }); break
      case "react": this.reactCb({ chatId: m.chatId, messageId: m.messageId, emoji: m.emoji }); break
      case "edit": this.editCb({ chatId: m.chatId, messageId: m.messageId, text: m.text }); break
      case "attach":
        this.attachCb({ chatId: m.chatId, path: m.path, caption: m.caption, filename: m.filename }); break
      case "update": this.updateCb({ chatId: m.chatId, card: m.card, correlationId: m.correlationId }); break
      case "finish": this.finishCb(); break
      case "remember":
        this.rememberCb({ scope: m.scope, title: m.title, tags: m.tags, body: m.body }); break
      case "post_webhook":
        this.postWebhookCb({ target: m.target, body: m.body }); break
      case "recall":
        // Request/response: run retrieval, then write the result back keyed by id.
        void this.recallCb({ query: m.query, scopes: m.scopes }).then((notes) => {
          try { socket.write(encode({ t: "recall_result", id: m.id, notes })) } catch {}
        })
        break
      case "ask_agent":
        // Request/response: run the consulted agent, then write its answer back by id.
        void this.askAgentCb({ agent: m.agent, message: m.message }).then((answer) => {
          try { socket.write(encode({ t: "ask_agent_result", id: m.id, answer })) } catch {}
        })
        break
    }
  }

  async close(): Promise<void> {
    this.server?.stop(true)
    try { unlinkSync(this.socketPath) } catch {}
  }
}
