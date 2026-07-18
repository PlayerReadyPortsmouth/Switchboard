#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { encode, LineDecoder } from "../hub/framing"

/** Validate a card argument for post_card / update_card. Returns a human-readable
 *  reason string when the card is malformed, or null when it is well-formed. The
 *  caller rejects the tool call with this reason so the AGENT sees exactly what is
 *  wrong (and can reproduce/fix it) rather than emitting a broken embed to Discord. */
export function validateCard(card: any): string | null {
  if (card == null || typeof card !== "object" || Array.isArray(card))
    return "card is required and must be an object with title, body, and buttons"
  if (typeof card.title !== "string" || card.title.trim() === "")
    return "card.title is required and must be a non-empty string"
  if (typeof card.body !== "string")
    return "card.body is required and must be a string (use \"\" for none)"
  if (!Array.isArray(card.buttons))
    return "card.buttons is required and must be an array (use [] for no buttons)"
  for (let i = 0; i < card.buttons.length; i++) {
    const b = card.buttons[i]
    if (b == null || typeof b !== "object" || Array.isArray(b))
      return `card.buttons[${i}] must be an object with customId and label`
    if (typeof b.customId !== "string" || b.customId === "")
      return `card.buttons[${i}].customId is required and must be a non-empty string`
    if (typeof b.label !== "string" || b.label === "")
      return `card.buttons[${i}].label is required and must be a non-empty string`
  }
  return null
}

/** Required non-empty string args per tool. Card tools also delegate to
 *  validateCard. Tools not listed have no required scalar args. */
const REQUIRED_STRING_ARGS: Record<string, string[]> = {
  post_card: ["chat_id"],
  update_card: ["chat_id", "correlation_id"],
  react: ["chat_id", "message_id", "emoji"],
  edit_message: ["chat_id", "message_id", "text"],
  attach_file: ["chat_id", "path"],
  post_webhook: ["target"],
  remember: ["title", "body"],
  notify_peer: ["target", "text"],
}

/** Validate a tool call's arguments at the shim boundary BEFORE the frame is
 *  written to the hub socket. Returns a human-readable reason when the args are
 *  malformed (so the AGENT sees exactly what's wrong and can reproduce/fix),
 *  or null when they are well-formed. Card tools additionally run validateCard. */
export function validateToolArgs(name: string, args: Record<string, any>): string | null {
  for (const field of REQUIRED_STRING_ARGS[name] ?? []) {
    if (typeof args[field] !== "string" || args[field] === "")
      return `${field} is required and must be a non-empty string`
  }
  if (name === "post_card" || name === "update_card")
    return validateCard(args.card)
  return null
}

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
    case "post_webhook":
      return { t: "post_webhook", target: args.target, body: args.body }
    case "attach_file":
      return { t: "attach", chatId: args.chat_id, path: args.path, caption: args.caption, filename: args.filename }
    case "publish_link":
      return { t: "publish", path: args.path, mode: args.mode, title: args.title, scope: args.scope, ttlDays: args.ttl_days, visibility: args.visibility }
    case "notify_peer":
      return { t: "notify_peer", target: args.target, text: args.text }
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
  // When RECEIPTS=1 the hub confirms outbound posts (post_card/update_card/attach_file)
  // with a `<t>_result` frame, so the agent gets a real message id / error back instead
  // of a blind "sent". Off ⇒ these stay fire-and-forget exactly as before.
  const RECEIPTS = process.env.RECEIPTS === "1"
  const RECEIPT_RESULT: Record<string, string> = {
    post_card: "notify_result", update_card: "update_result", attach_file: "attach_result",
  }
  let reqCounter = 0
  const pending = new Map<string, (notes: { title: string; body: string }[]) => void>()
  const pendingAsk = new Map<string, (answer: string) => void>()
  const pendingPeerAsk = new Map<string, (answer: string) => void>()
  const pendingPublish = new Map<string, (r: { url?: string; error?: string }) => void>()
  const pendingReceipt = new Map<string, (r: { ok: boolean; messageId?: string; error?: string }) => void>()
  const decoder = new LineDecoder()
  const sock = await Bun.connect({
    unix: SOCKET,
    socket: {
      data(_s, data) {
        for (const obj of decoder.push(data.toString())) {
          const m = obj as { t?: string; id?: string; notes?: { title: string; body: string }[]; answer?: string; url?: string; error?: string; ok?: boolean; messageId?: string }
          if (m.t === "recall_result" && m.id && pending.has(m.id)) {
            pending.get(m.id)!(m.notes ?? [])
            pending.delete(m.id)
          } else if (m.t === "ask_agent_result" && m.id && pendingAsk.has(m.id)) {
            pendingAsk.get(m.id)!(m.answer ?? "")
            pendingAsk.delete(m.id)
          } else if (m.t === "ask_peer_result" && m.id && pendingPeerAsk.has(m.id)) {
            pendingPeerAsk.get(m.id)!(m.answer ?? "")
            pendingPeerAsk.delete(m.id)
          } else if (m.t === "publish_result" && m.id && pendingPublish.has(m.id)) {
            pendingPublish.get(m.id)!({ url: m.url, error: m.error }); pendingPublish.delete(m.id)
          } else if (m.t && m.t.endsWith("_result") && m.id && pendingReceipt.has(m.id)) {
            pendingReceipt.get(m.id)!({ ok: !!m.ok, messageId: m.messageId, error: m.error }); pendingReceipt.delete(m.id)
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
      { name: "post_webhook",
        description: "Fire a pre-configured outbound webhook to an external system (e.g. notify a service, append to a sheet, page on-call). You address it by `target` — the route's id from the hub config — NOT a URL; the hub holds the destination and secret and delivers it signed and retried. Use only the named targets the operator has set up.",
        inputSchema: { type: "object", properties: {
          target: { type: "string", description: "The configured outbound route id to fire." },
          body: { type: "string", description: "Optional request body (used when the route has no template)." } },
          required: ["target"] } },
      // ask_agent is exposed only when the hub enables inter-agent consult.
      ...(process.env.CONSULT === "1" ? [{
        name: "ask_agent",
        description: "Consult another Switchboard agent by name and get its answer back. Use to delegate a sub-question to a specialist (e.g. ask the ops agent whether prod is healthy). You address it by `agent` — the agent's name from the hub config, never a URL; the hub runs that agent and returns its reply text. Only agents the operator has made consultable will answer; expect a short wait while the agent thinks.",
        inputSchema: { type: "object", properties: {
          agent: { type: "string", description: "The name of the agent to consult." },
          message: { type: "string", description: "Your question or task for that agent." } },
          required: ["agent", "message"] },
      }] : []),
      ...(process.env.ATTACH_FILES === "1" ? [{
        name: "attach_file",
        description: "Attach a file you have produced (e.g. a .md or .pdf report) to a Discord message. First WRITE the file into your outbox directory, then call this with its path RELATIVE to that outbox (e.g. \"report.pdf\"). Absolute paths or paths escaping your outbox are rejected. Optional `caption` is posted with the file; optional `filename` sets the display name (defaults to the file's basename).",
        inputSchema: { type: "object", properties: {
          chat_id: { type: "string", description: "The Discord channel id to post the file to." },
          path: { type: "string", description: "Path relative to your outbox directory." },
          caption: { type: "string", description: "Optional message text to post with the file." },
          filename: { type: "string", description: "Optional display name for the attachment." } },
          required: ["chat_id", "path"] },
      }] : []),
      ...(process.env.PUBLISH_LINK === "1" ? [{
        name: "publish_link",
        description: "Publish a file you produced (write it into your outbox first) to a staff-only Entra-gated URL and get the link back. Use for artifacts too big or unviewable as Discord attachments (PDF statements, rendered HTML dashboards, large CSVs, markdown reports). `mode`: download | page (live HTML) | view (pretty pdf/markdown/csv); inferred from the file type if omitted. `scope`: \"staff\" (default) or an RA permission string for sensitive data. `ttl_days`: link lifetime — OMIT it to make the file a permanent entry in the org's Documents library (default is now permanent, not 30 days); pass a number only for a genuinely temporary link. `visibility`: \"private\" (owner-only, the default) or \"org\" (visible org-wide in the Documents library).",
        inputSchema: { type: "object", properties: {
          path: { type: "string", description: "Path relative to your outbox." },
          mode: { type: "string", enum: ["download", "page", "view"] },
          title: { type: "string" },
          scope: { type: "string", description: "\"staff\" or an RA permission string." },
          visibility: { type: "string", enum: ["private", "org"], description: "private (owner-only, default) or org (org-wide)." },
          ttl_days: { type: "number", description: "Omit for a permanent Documents-library entry; set for a temporary link." } },
          required: ["path"] },
      }] : []),
      ...(process.env.PEERING === "1" ? [
        { name: "notify_peer",
          description: "Send a one-way message to an agent on another Switchboard hub (no reply). Address it `peer:agent` — the peer name from hub config and the remote agent's name. Delivery is queued + retried; you get back a queued ack, not the remote agent's response.",
          inputSchema: { type: "object", properties: {
            target: { type: "string", description: "Remote address as \"peer:agent\"." },
            text: { type: "string", description: "The message to deliver." } },
            required: ["target", "text"] } },
        { name: "ask_peer",
          description: "Ask an agent on another Switchboard hub a question and get its answer back. Address it `peer:agent`. The remote hub runs that agent and returns its reply; expect a wait while it thinks. Only agents the remote operator has made peer-reachable will answer.",
          inputSchema: { type: "object", properties: {
            target: { type: "string", description: "Remote address as \"peer:agent\"." },
            message: { type: "string", description: "Your question or task for the remote agent." } },
            required: ["target", "message"] } },
      ] : []),
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
    // ask_peer is request/response: send, await the remote hub's reply.
    if (req.params.name === "ask_peer") {
      const id = `pa${++reqCounter}`
      const answer = await new Promise<string>((resolve) => {
        pendingPeerAsk.set(id, resolve)
        sock.write(encode({ t: "ask_peer", id, target: args.target, message: args.message }))
        const timer = setTimeout(() => { if (pendingPeerAsk.delete(id)) resolve("(the peer agent did not respond in time)") }, 310000)
        ;(timer as { unref?: () => void }).unref?.()
      })
      return { content: [{ type: "text", text: answer }] }
    }
    // ask_agent is request/response: send, await the consulted agent's reply.
    if (req.params.name === "ask_agent") {
      const id = `a${++reqCounter}`
      const answer = await new Promise<string>((resolve) => {
        pendingAsk.set(id, resolve)
        sock.write(encode({ t: "ask_agent", id, agent: args.agent, message: args.message }))
        const timer = setTimeout(() => { if (pendingAsk.delete(id)) resolve("(the agent did not respond in time)") }, 120000)
        ;(timer as { unref?: () => void }).unref?.()
      })
      return { content: [{ type: "text", text: answer }] }
    }
    if (req.params.name === "publish_link") {
      const id = `p${++reqCounter}`
      const result = await new Promise<{ url?: string; error?: string }>((resolve) => {
        pendingPublish.set(id, resolve)
        sock.write(encode({ t: "publish", id, path: args.path, mode: args.mode, title: args.title, scope: args.scope, ttlDays: args.ttl_days, visibility: args.visibility }))
        const timer = setTimeout(() => { if (pendingPublish.delete(id)) resolve({ error: "timed out" }) }, 30000)
        ;(timer as { unref?: () => void }).unref?.()
      })
      const text = result.url ? `Published: ${result.url}` : `publish failed: ${result.error ?? "unknown"}`
      return { content: [{ type: "text", text }] }
    }
    // Validate the tool's args at the boundary BEFORE writing to the hub socket:
    // fail the call with a descriptive reason so the agent can fix + retry, never a
    // broken embed (or silently dropped action) for the user.
    const reason = validateToolArgs(req.params.name, args)
    if (reason) return { content: [{ type: "text", text: `${req.params.name} failed: ${reason}` }], isError: true }
    const wire = toolCallToWire(req.params.name, args)
    if (!wire) return { content: [{ type: "text", text: `unknown tool: ${req.params.name}` }], isError: true }
    // With receipts on, the content-posters become request/response: attach an id,
    // await the hub's confirmation, and report the Discord message id (or the error)
    // so the agent knows the post actually landed rather than assuming a blind "sent".
    const resultType = RECEIPT_RESULT[req.params.name]
    if (RECEIPTS && resultType) {
      const id = `s${++reqCounter}`
      const outcome = await new Promise<{ ok: boolean; messageId?: string; error?: string }>((resolve) => {
        pendingReceipt.set(id, resolve)
        sock.write(encode({ ...wire, id }))
        const timer = setTimeout(() => { if (pendingReceipt.delete(id)) resolve({ ok: true, error: "unconfirmed" }) }, 10000)
        ;(timer as { unref?: () => void }).unref?.()
      })
      if (!outcome.ok)
        return { content: [{ type: "text", text: `${req.params.name} failed: ${outcome.error ?? "the hub could not deliver it"}` }], isError: true }
      if (outcome.error === "unconfirmed")
        return { content: [{ type: "text", text: "sent (unconfirmed — the hub did not acknowledge in time)" }] }
      return { content: [{ type: "text", text: outcome.messageId ? `posted: ${outcome.messageId}` : "posted" }] }
    }
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
