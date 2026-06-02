#!/usr/bin/env bun
// Approve a pairing code: bun run scripts/pair.ts <code>
import { join } from "path"
import { homedir } from "os"
import { BaseGate } from "../hub/baseGate"

const code = process.argv[2]
if (!code) { console.error("usage: bun run scripts/pair.ts <code>"); process.exit(1) }
const stateDir = process.env.SWITCHBOARD_STATE_DIR ?? join(homedir(), ".switchboard")
const gate = new BaseGate(join(stateDir, "access.json"))
const r = gate.approve(code, Date.now())
if (!r) { console.error(`no pending code "${code}"`); process.exit(1) }
console.log(`approved ${r.senderId} — they can now DM the bot`)
