import { unlinkSync } from "fs"
import type { Socket } from "bun"
import type { CardSpec } from "../types"
import { LineDecoder } from "../framing"

type Conn = { socket: Socket<unknown>; decoder: LineDecoder }

/** A Unix-socket server the agent's shim connects to, forwarding tool calls
 *  (post_card / react / edit) from the agent process to the hub. */
export class ShimSocketServer {
  private server?: ReturnType<typeof Bun.listen>
  private registered = false
  private regCb: () => void = () => {}
  private notifyCb: (n: { chatId: string; card: CardSpec; correlationId: string }) => void = () => {}
  private reactCb: (r: { chatId: string; messageId: string; emoji: string }) => void = () => {}
  private editCb: (e: { chatId: string; messageId: string; text: string }) => void = () => {}

  constructor(private socketPath: string) {}

  onRegister(cb: () => void) { this.regCb = cb }
  onNotify(cb: typeof this.notifyCb) { this.notifyCb = cb }
  onReact(cb: typeof this.reactCb) { this.reactCb = cb }
  onEdit(cb: typeof this.editCb) { this.editCb = cb }
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
          for (const obj of c.decoder.push(data.toString())) self.dispatch(obj as any)
        },
      },
    })
  }

  private dispatch(m: any): void {
    switch (m.t) {
      case "register": this.registered = true; this.regCb(); break
      case "notify": this.notifyCb({ chatId: m.chatId, card: m.card, correlationId: m.correlationId }); break
      case "react": this.reactCb({ chatId: m.chatId, messageId: m.messageId, emoji: m.emoji }); break
      case "edit": this.editCb({ chatId: m.chatId, messageId: m.messageId, text: m.text }); break
    }
  }

  async close(): Promise<void> {
    this.server?.stop(true)
    try { unlinkSync(this.socketPath) } catch {}
  }
}
