#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import { encode, LineDecoder } from "../hub/framing"

interface WireInbound {
  chatKey: string
  inbound: { chatId: string; messageId: string; userId: string; user: string
    content: string; ts: string; isDM: boolean
    attachments?: { name: string; type: string; size: number }[] }
}

/** Translate a hub socket inbound into the channel-notification params CC expects. */
export function inboundToChannelNotification(w: WireInbound) {
  const i = w.inbound
  return {
    content: i.content,
    meta: {
      chat_id: i.chatId, message_id: i.messageId,
      user: i.user, user_id: i.userId, ts: i.ts,
    },
  }
}

/** Translate an MCP tool call from CC into the wire message for the hub. */
export function toolCallToWire(name: string, args: Record<string, any>) {
  switch (name) {
    case "reply":
      return { t: "reply", chatId: args.chat_id, text: args.text,
        replyTo: args.reply_to, files: args.files }
    case "react":
      return { t: "react", chatId: args.chat_id, messageId: args.message_id, emoji: args.emoji }
    case "edit_message":
      return { t: "edit", chatId: args.chat_id, messageId: args.message_id, text: args.text }
    default:
      return null
  }
}

async function main() {
  const SOCKET = process.env.HUB_SOCKET
  const AGENT = process.env.AGENT_NAME
  if (!SOCKET || !AGENT) {
    process.stderr.write("shim: HUB_SOCKET and AGENT_NAME required\n"); process.exit(1)
  }

  const mcp = new Server(
    { name: "switchboard-shim", version: "1.0.0" },
    { capabilities: { tools: {}, experimental: { "claude/channel": {} } },
      instructions:
        "Messages from Discord arrive as <channel ...>. Reply with the reply tool, " +
        "passing chat_id back. Use react and edit_message as needed. Your transcript " +
        "output never reaches the user — only the reply tool does." },
  )

  const dec = new LineDecoder()
  const sock = await Bun.connect({
    unix: SOCKET,
    socket: {
      data(_s, data) {
        for (const obj of dec.push(data.toString())) {
          const m = obj as any
          if (m.t === "inbound") {
            void mcp.notification({
              method: "notifications/claude/channel",
              params: inboundToChannelNotification(m),
            })
          } else if (m.t === "permission_result") {
            void mcp.notification({
              method: "notifications/claude/channel/permission",
              params: { request_id: m.requestId, behavior: m.behavior },
            })
          }
        }
      },
    },
  })
  sock.write(encode({ t: "register", agent: AGENT }))

  // CC → shim: a tool wants permission. Forward it onto the hub socket.
  mcp.setNotificationHandler(
    z.object({
      method: z.literal("notifications/claude/channel/permission_request"),
      params: z.object({
        request_id: z.string(),
        tool_name: z.string(),
        description: z.string(),
        input_preview: z.string(),
      }),
    }) as any,
    async ({ params }: any) => {
      sock.write(encode({ t: "permission_request", requestId: params.request_id,
        toolName: params.tool_name, description: params.description, inputPreview: params.input_preview }))
    },
  )

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: "reply", description: "Reply on Discord. Pass chat_id from the inbound message.",
        inputSchema: { type: "object", properties: {
          chat_id: { type: "string" }, text: { type: "string" },
          reply_to: { type: "string" }, files: { type: "array", items: { type: "string" } } },
          required: ["chat_id", "text"] } },
      { name: "react", description: "Add an emoji reaction to a message.",
        inputSchema: { type: "object", properties: {
          chat_id: { type: "string" }, message_id: { type: "string" }, emoji: { type: "string" } },
          required: ["chat_id", "message_id", "emoji"] } },
      { name: "edit_message", description: "Edit a message the bot previously sent.",
        inputSchema: { type: "object", properties: {
          chat_id: { type: "string" }, message_id: { type: "string" }, text: { type: "string" } },
          required: ["chat_id", "message_id", "text"] } },
    ],
  }))

  mcp.setRequestHandler(CallToolRequestSchema, async req => {
    const wire = toolCallToWire(req.params.name, (req.params.arguments ?? {}) as any)
    if (!wire) return { content: [{ type: "text", text: `unknown tool: ${req.params.name}` }], isError: true }
    sock.write(encode(wire))
    return { content: [{ type: "text", text: "sent" }] }
  })

  await mcp.connect(new StdioServerTransport())
}

if (import.meta.main) void main()
