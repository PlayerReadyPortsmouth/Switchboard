#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { encode, LineDecoder } from "../hub/framing"

/** Translate a fire-and-forget MCP tool call from CC into the wire message for
 *  the hub. `recall` is request/response and handled separately. */
export function toolCallToWire(name: string, args: Record<string, any>) {
  switch (name) {
    case "react":
      return { t: "react", chatId: args.chat_id, messageId: args.message_id, emoji: args.emoji }
    case "edit_message":
      return { t: "edit", chatId: args.chat_id, messageId: args.message_id, text: args.text }
    case "post_card":
      return { t: "notify", chatId: args.chat_id, card: args.card, correlationId: args.correlation_id }
    case "update_card":
      return { t: "update", chatId: args.chat_id, correlationId: args.correlation_id, card: args.card }
    case "finish":
      return { t: "finish" }
    case "remember":
      return { t: "remember", scope: args.scope, title: args.title, tags: args.tags, body: args.body }
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

  // Connect to the hub socket to FORWARD tool calls (agent → hub) and to read
  // back `recall` results. Inbound messages and button interactions reach this
  // agent via its stdin (the hub owns the process), not through this socket.
  let reqCounter = 0
  const pending = new Map<string, (notes: { title: string; body: string }[]) => void>()
  const decoder = new LineDecoder()
  const sock = await Bun.connect({
    unix: SOCKET,
    socket: {
      data(_s, data) {
        for (const obj of decoder.push(data.toString())) {
          const m = obj as { t?: string; id?: string; notes?: { title: string; body: string }[] }
          if (m.t === "recall_result" && m.id && pending.has(m.id)) {
            pending.get(m.id)!(m.notes ?? [])
            pending.delete(m.id)
          }
        }
      },
    },
  })
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
              emoji: { type: "string" },
              modal: { type: "object", properties: {
                title: { type: "string" },
                inputs: { type: "array", items: { type: "object", properties: {
                  id: { type: "string" }, label: { type: "string" },
                  style: { type: "string", enum: ["short", "paragraph"] },
                  placeholder: { type: "string" }, required: { type: "boolean" } }, required: ["id", "label", "style"] } } },
                required: ["title", "inputs"] } },
              required: ["customId", "label"] } },
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
      { name: "update_card",
        description: "Edit a card you previously posted, identified by its correlation_id. Replaces the embed + buttons in place. Use this for every progress update instead of posting a new card.",
        inputSchema: { type: "object", properties: {
          chat_id: { type: "string" },
          correlation_id: { type: "string" },
          card: { type: "object", properties: {
            title: { type: "string" }, body: { type: "string" }, footer: { type: "string" },
            fields: { type: "array", items: { type: "object", properties: {
              name: { type: "string" }, value: { type: "string" }, inline: { type: "boolean" } }, required: ["name", "value"] } },
            buttons: { type: "array", items: { type: "object", properties: {
              customId: { type: "string" }, label: { type: "string" },
              style: { type: "string", enum: ["primary", "secondary", "success", "danger"] },
              emoji: { type: "string" },
              modal: { type: "object", properties: {
                title: { type: "string" },
                inputs: { type: "array", items: { type: "object", properties: {
                  id: { type: "string" }, label: { type: "string" },
                  style: { type: "string", enum: ["short", "paragraph"] },
                  placeholder: { type: "string" }, required: { type: "boolean" } }, required: ["id", "label", "style"] } } },
                required: ["title", "inputs"] } },
              required: ["customId", "label"] } },
          }, required: ["title", "body", "buttons"] } },
          required: ["chat_id", "correlation_id", "card"] } },
      { name: "finish",
        description: "Signal you have completed your task and need no further turns. For an ephemeral (spawned) agent this ends and tears down the session; for a persistent agent it simply ends the turn.",
        inputSchema: { type: "object", properties: {} } },
      { name: "remember",
        description: "Save a durable note to the memory vault so it can be recalled in future conversations. Use for stable facts, preferences, and learnings — not transient chatter. `scope` defaults to your own agent memory; pass \"global\" for shared knowledge, \"users/<id>\" for a person, or \"channels/<id>\" for a project.",
        inputSchema: { type: "object", properties: {
          scope: { type: "string", description: "global | users/<id> | agents/<name> | channels/<id> (default: your own)" },
          title: { type: "string", description: "Short, stable title — reusing it updates the existing note." },
          tags: { type: "array", items: { type: "string" } },
          body: { type: "string", description: "Markdown body; [[wikilinks]] allowed." } },
          required: ["title", "body"] } },
      { name: "recall",
        description: "Search the memory vault for notes relevant to a query and get their contents back. Use before answering when prior context might help.",
        inputSchema: { type: "object", properties: {
          query: { type: "string" },
          scopes: { type: "array", items: { type: "string" }, description: "Scopes to search; defaults to global + your own agent memory." } },
          required: ["query"] } },
    ],
  }))

  mcp.setRequestHandler(CallToolRequestSchema, async req => {
    const args = (req.params.arguments ?? {}) as Record<string, any>
    // recall is request/response: send, await the hub's result (or time out empty).
    if (req.params.name === "recall") {
      const id = `r${++reqCounter}`
      const notes = await new Promise<{ title: string; body: string }[]>((resolve) => {
        pending.set(id, resolve)
        sock.write(encode({ t: "recall", id, query: args.query, scopes: args.scopes }))
        const timer = setTimeout(() => { if (pending.delete(id)) resolve([]) }, 10000)
        ;(timer as { unref?: () => void }).unref?.()
      })
      const text = notes.length
        ? notes.map((n) => `## ${n.title}\n${n.body}`).join("\n\n")
        : "(no relevant memory found)"
      return { content: [{ type: "text", text }] }
    }
    const wire = toolCallToWire(req.params.name, args)
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
