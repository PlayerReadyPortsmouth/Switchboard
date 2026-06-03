#!/usr/bin/env bun
// Real-CLI proof: spawn a stream-json agent via StreamJsonTransport, deliver a
// message, assert a stdout reply AND a socket-relayed card. Requires an
// authenticated `claude` on PATH. Usage: bun run scripts/smoke-streamjson.ts
import { join } from "path"
import { StreamJsonTransport, makeBunProcessSpawner } from "../hub/transports/streamJson"
import { ShimSocketServer } from "../hub/transports/shimSocket"
import type { AgentConfig } from "../hub/types"

const cfg: AgentConfig = {
  emoji: "x", description: "smoke", mode: "ephemeral",
  access: { roles: [] },
  runtime: {
    cwd: import.meta.dir, model: "claude-haiku-4-5",
    appendSystemPrompt:
      "When you receive a message, FIRST call mcp__switchboard-shim__post_card with chat_id='c1' " +
      "and card={title:'Hi',body:'b',buttons:[{customId:'t:x:1',label:'OK'}]}. THEN reply with exactly SMOKE_OK.",
  },
}
const socketPath = "/tmp/sb-smoke.sock"
let reply: string | null = null, card = false
const t = new StreamJsonTransport("smoke", cfg, {
  spawner: makeBunProcessSpawner(),
  socket: new ShimSocketServer(socketPath),
  shimPath: join(import.meta.dir, "..", "shim", "server.ts"),
  socketPath, mcpConfigPath: "/tmp/sb-smoke.mcp.json",
})
t.onReply((r) => { if (r.kind === "reply") reply = r.text ?? null; if (r.kind === "card") card = true })
await t.start()
t.deliver("c1", { chatId: "c1", messageId: "m", userId: "u", user: "x", content: "ping", ts: new Date().toISOString(), isDM: false })
const start = Date.now()
while ((reply === null || !card) && Date.now() - start < 120_000) await new Promise((r) => setTimeout(r, 500))
console.error("reply:", reply, "| card:", card)
await t.close()
process.exit(reply !== null && card ? 0 : 1)
