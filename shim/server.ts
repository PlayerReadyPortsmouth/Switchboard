#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { encode } from "../hub/framing"

/** Translate an MCP tool call from CC into the wire message for the hub. */
export function toolCallToWire(name: string, args: Record<string, any>) {
  switch (name) {
    case "react":
      return { t: "react", chatId: args.chat_id, messageId: args.message_id, emoji: args.emoji }
    case "edit_message":
      return { t: "edit", chatId: args.chat_id, messageId: args.message_id, text: args.text }
    case "post_card":
      return { t: "notify", chatId: args.chat_id, card: args.card, correlationId: args.correlation_id }
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
    { name: "switchboard-shim", version: "2.0.0" },
    { capabilities: { tools: {} },
      instructions:
        "Post rich cards to Discord with post_card; use react and edit_message as needed. " +
        "Your normal text response IS your reply to the user — you do not need a separate reply tool." },
  )

  // Connect to the hub socket purely to FORWARD tool calls (agent → hub).
  // Inbound messages and button interactions reach this agent via its stdin
  // (the hub owns the process), not through this socket.
  const sock = await Bun.connect({ unix: SOCKET, socket: { data() {} } })
  sock.write(encode({ t: "register", agent: AGENT }))

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: "post_card",
        description: "Post a rich card (embed + buttons) to a Discord channel. Button clicks return to you as a `[interaction] custom_id=… user_id=…` message. Pass a correlation_id (e.g. the ticket id) to tie clicks to this card.",
        inputSchema: { type: "object", properties: {
          chat_id: { type: "string" },
          correlation_id: { type: "string" },
          card: { type: "object", properties: {
            title: { type: "string" }, body: { type: "string" },
            footer: { type: "string" },
            fields: { type: "array", items: { type: "object", properties: {
              name: { type: "string" }, value: { type: "string" }, inline: { type: "boolean" } }, required: ["name", "value"] } },
            buttons: { type: "array", items: { type: "object", properties: {
              customId: { type: "string" }, label: { type: "string" },
              style: { type: "string", enum: ["primary", "secondary", "success", "danger"] },
              emoji: { type: "string" } }, required: ["customId", "label"] } },
          }, required: ["title", "body", "buttons"] } },
          required: ["chat_id", "card"] } },
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

if (import.meta.main) {
  main().catch(err => {
    process.stderr.write(`switchboard shim: fatal: ${err}\n`)
    process.exit(1)
  })
}
