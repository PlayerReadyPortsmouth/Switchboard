#!/usr/bin/env bun
// Approve a pairing code: bun run scripts/pair.ts <code>
import { join } from "path"
import { loadConfigs } from "../hub/config"
import { BaseGate } from "../hub/baseGate"
import { writeApproval } from "../hub/approvals"

const code = process.argv[2]
if (!code) { console.error("usage: bun run scripts/pair.ts <code>"); process.exit(1) }

const configDir = process.env.SWITCHBOARD_CONFIG ?? join(import.meta.dir, "..", "config")
const { hub } = loadConfigs(configDir)
const gate = new BaseGate(join(hub.stateDir, "access.json"))
const r = gate.approve(code, Date.now())
if (!r) { console.error(`no pending code "${code}"`); process.exit(1) }
writeApproval(hub.stateDir, r.senderId, r.chatId)   // hub will DM the user a confirmation
console.log(`approved ${r.senderId} — they can now DM the bot (confirmation will be sent)`)
