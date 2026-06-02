import { unlinkSync } from "fs"
import type { Socket } from "bun"
import type { InboundMessage, AgentReply } from "../types"
import type { AgentTransport } from "./index"
import { encode, LineDecoder } from "../framing"

type Conn = { socket: Socket<unknown>; decoder: LineDecoder; registered: boolean }

/** Persistent agent: a Unix-socket server; one connected shim handles this agent. */
export class ChannelShimTransport implements AgentTransport {
  private server?: ReturnType<typeof Bun.listen>
  private conn: Conn | null = null
  private cb: (r: AgentReply) => void = () => {}
  private permCb: (requestId: string, behavior: "allow" | "deny") => void = () => {}
  private permReqCb: (req: { requestId: string; toolName: string; description: string; inputPreview: string }) => void = () => {}

  constructor(public readonly name: string, private socketPath: string) {}

  async listen(): Promise<void> {
    try { unlinkSync(this.socketPath) } catch {}
    const self = this
    this.server = Bun.listen({
      unix: this.socketPath,
      socket: {
        open(socket) { (socket as any).__conn = { socket, decoder: new LineDecoder(), registered: false } },
        data(socket, data) {
          const conn: Conn = (socket as any).__conn
          for (const obj of conn.decoder.push(data.toString())) self.onMessage(conn, obj as any)
        },
        close(socket) {
          if (self.conn && self.conn.socket === socket) self.conn = null
        },
      },
    })
  }

  private onMessage(conn: Conn, msg: any): void {
    switch (msg.t) {
      case "register":
        conn.registered = true
        this.conn = conn
        break
      case "reply":
        this.cb({ agent: this.name, kind: "reply", chatId: msg.chatId,
          text: msg.text, replyTo: msg.replyTo, files: msg.files })
        break
      case "react":
        this.cb({ agent: this.name, kind: "react", chatId: msg.chatId,
          messageId: msg.messageId, emoji: msg.emoji })
        break
      case "edit":
        this.cb({ agent: this.name, kind: "edit", chatId: msg.chatId,
          messageId: msg.messageId, text: msg.text })
        break
      case "permission_request":
        this.permReqCb({ requestId: msg.requestId, toolName: msg.toolName,
          description: msg.description, inputPreview: msg.inputPreview })
        break
    }
  }

  onReply(cb: (r: AgentReply) => void): void { this.cb = cb }
  onPermissionRequest(cb: typeof this.permReqCb): void { this.permReqCb = cb }
  isAvailable(): boolean { return this.conn?.registered === true }

  deliver(chatKey: string, inbound: InboundMessage): void {
    if (!this.conn) return
    this.conn.socket.write(encode({ t: "inbound", chatKey, inbound }))
  }

  /** Used in Task 16 to relay a permission answer back to this agent's shim. */
  sendPermissionResult(requestId: string, behavior: "allow" | "deny"): void {
    this.conn?.socket.write(encode({ t: "permission_result", requestId, behavior }))
  }

  async close(): Promise<void> {
    this.server?.stop(true)
    try { unlinkSync(this.socketPath) } catch {}
  }
}
