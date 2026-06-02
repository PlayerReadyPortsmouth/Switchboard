# Switchboard Gap-Closure Plan (Increment 2)

> **For agentic workers:** implement task-by-task with TDD where unit-testable; the discord.js wiring is compile-checked + manual-E2E. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Close the three code gaps the v1 final review flagged: (G1/G2) wire the interactive permission relay for persistent agents end-to-end into the hub; (G3) send the user a Discord confirmation after `pair.ts` approves them, and make `stateDir` a single source of truth.

**Context:** v1 is on `master` (69 tests pass). The permission relay was scaffolded — `hub/permissions.ts` (`PermissionRouter`), `ChannelShimTransport.onPermissionRequest`/`sendPermissionResult`, and the shim's `permission_request`/`permission_result` bridging all exist and are tested — but `hub/index.ts` never subscribes to it, so a persistent agent hitting a tool-approval prompt stalls. We follow spec §7: the prompt goes to every base-gate `allowFrom` user; the answer (button click or `y/n <code>` text reply) routes back to the originating agent's shim only.

**Design decisions (spec §7):**
- Permission prompts are sent to the base-gate allowlist (`allowFrom`) users via DM, with Allow/Deny buttons. Group channels are excluded (only explicitly-paired users answer).
- `request_id` from Claude Code is treated as an opaque token (no format assumption for the button customId). The text-reply path matches the documented `y/n <5-letter-code>` form from the upstream plugin.
- A persistent agent is one shared session; any allowlisted user may answer its permission prompt (acceptable for v1 — they are all trusted/paired). Noted in code comments.

---

## Task G1: Permission-reply parsing + orchestrator intercept

**Files:**
- Modify: `hub/permissions.ts`
- Test: `tests/permissions.test.ts` (extend)
- Modify: `hub/orchestrator.ts`
- Test: `tests/orchestrator.test.ts` (extend)

- [ ] **Step 1: Write the failing test** — append to `tests/permissions.test.ts`

```ts
import { parsePermissionReply } from "../hub/permissions"

test("parses an allow reply", () => {
  expect(parsePermissionReply("y abcde")).toEqual({ behavior: "allow", code: "abcde" })
  expect(parsePermissionReply("YES abcde")).toEqual({ behavior: "allow", code: "abcde" })
})

test("parses a deny reply", () => {
  expect(parsePermissionReply("n abcde")).toEqual({ behavior: "deny", code: "abcde" })
  expect(parsePermissionReply("no abcde")).toEqual({ behavior: "deny", code: "abcde" })
})

test("rejects non-permission text", () => {
  expect(parsePermissionReply("no idea what to do")).toBeNull()
  expect(parsePermissionReply("yes")).toBeNull()
  expect(parsePermissionReply("hello there")).toBeNull()
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/permissions.test.ts`
Expected: FAIL — `parsePermissionReply` not exported.

- [ ] **Step 3: Implement** — add to `hub/permissions.ts`

```ts
// Permission text-reply form: "y xxxxx" / "yes xxxxx" / "n xxxxx" / "no xxxxx".
// Code is the 5-letter request id (a-z minus 'l'). Case-insensitive. Strict:
// no bare yes/no, no surrounding chatter — keeps normal chat from matching.
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

export function parsePermissionReply(text: string): { behavior: "allow" | "deny"; code: string } | null {
  const m = PERMISSION_REPLY_RE.exec(text)
  if (!m) return null
  return {
    behavior: m[1]!.toLowerCase().startsWith("y") ? "allow" : "deny",
    code: m[2]!.toLowerCase(),
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/permissions.test.ts`
Expected: 6 pass (3 prior + 3 new).

- [ ] **Step 5: Write the failing orchestrator-intercept test** — append to `tests/orchestrator.test.ts`

```ts
test("a y/n <code> reply for a known permission resolves it and does not dispatch", async () => {
  const f = fakes()
  const resolved: { code: string; behavior: string }[] = []
  f.deps.resolvePermission = (code: string, behavior: string) => {
    if (code !== "abcde") return false
    resolved.push({ code, behavior }); return true
  }
  const o = new Orchestrator(hub, reg, f.deps as any)
  await o.handleMessage(dm("y abcde"))
  expect(resolved).toEqual([{ code: "abcde", behavior: "allow" }])
  expect(f.dispatched.length).toBe(0)
})

test("a y/n <code> reply for an UNKNOWN code falls through to normal handling", async () => {
  const f = fakes()
  f.deps.resolvePermission = () => false   // unknown code
  const o = new Orchestrator(hub, reg, f.deps as any)
  await o.handleMessage(dm("y zzzzz"))
  expect(f.dispatched.length).toBe(1)      // treated as a normal message → routed
})
```

> Add `resolvePermission: (_code: string, _behavior: string) => false` to the default `fakes().deps` object so existing tests keep compiling.

- [ ] **Step 6: Run to verify it fails**

Run: `bun test tests/orchestrator.test.ts`
Expected: FAIL — `resolvePermission` not used / not in deps.

- [ ] **Step 7: Implement the intercept** — in `hub/orchestrator.ts`

Add to `OrchestratorDeps`:
```ts
  /** Resolve a permission reply by code; returns true if the code was a live request. */
  resolvePermission: (code: string, behavior: "allow" | "deny") => boolean
```

Add the import at the top:
```ts
import { parsePermissionReply } from "./permissions"
```

In `handleMessage`, AFTER the base-gate block (pair/drop) and BEFORE `resolveRoles`, insert:
```ts
    // Permission text-reply intercept: "y/n <code>" from a paired user. Only
    // consume it if the code maps to a live permission request; otherwise it's
    // ordinary chat and falls through.
    const perm = parsePermissionReply(inbound.content)
    if (perm && this.deps.resolvePermission(perm.code, perm.behavior)) return
```

- [ ] **Step 8: Run to verify it passes**

Run: `bun test tests/orchestrator.test.ts && bun test`
Expected: orchestrator 8 pass; full suite green (was 69, now 69 + 3 perm + 2 orch = 74).

- [ ] **Step 9: Commit**

```bash
git add hub/permissions.ts tests/permissions.test.ts hub/orchestrator.ts tests/orchestrator.test.ts
git commit -m "feat: permission text-reply parsing + orchestrator intercept"
```

---

## Task G2: Wire the permission relay into the gateway + entrypoint

**Files:**
- Modify: `hub/baseGate.ts` (add `listAllowed()`)
- Test: `tests/baseGate.test.ts` (extend)
- Modify: `hub/gateway.ts` (prompt sender + button handler)
- Modify: `hub/index.ts` (subscribe + route answers)

- [ ] **Step 1: Write the failing test** — append to `tests/baseGate.test.ts`

```ts
test("listAllowed returns the allowFrom users", () => {
  const { gate } = gateWith({ dmPolicy: "pairing", allowFrom: ["u1", "u2"], groups: [], pending: {} })
  expect(gate.listAllowed().sort()).toEqual(["u1", "u2"])
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/baseGate.test.ts`
Expected: FAIL — `listAllowed` not a function.

- [ ] **Step 3: Implement `listAllowed`** — add to the `BaseGate` class in `hub/baseGate.ts`

```ts
  /** Current allowlisted user snowflakes (read live from access.json). */
  listAllowed(): string[] {
    return this.read().allowFrom
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/baseGate.test.ts`
Expected: 9 pass (8 prior + 1 new).

- [ ] **Step 5: Add the gateway prompt sender + button handler** — in `hub/gateway.ts`

Extend the discord.js imports:
```ts
import {
  Client, GatewayIntentBits, Partials, ChannelType,
  ButtonBuilder, ButtonStyle, ActionRowBuilder, type Message, type Interaction,
} from "discord.js"
```

Add fields + methods to the `Gateway` class:
```ts
  private permButtonCb: (requestId: string, behavior: "allow" | "deny") => void = () => {}
  private isAuthorized: (userId: string) => boolean = () => false

  /** Called by the hub: which users may answer permission prompts (base-gate allowlist). */
  setPermissionAuthorizer(fn: (userId: string) => boolean): void { this.isAuthorized = fn }
  onPermissionButton(cb: (requestId: string, behavior: "allow" | "deny") => void): void {
    this.permButtonCb = cb
  }

  /** DM each allowlisted user an Allow/Deny prompt for a tool-permission request. */
  async sendPermissionPrompt(
    userIds: string[], requestId: string, toolName: string,
  ): Promise<void> {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`perm:allow:${requestId}`).setLabel("Allow")
        .setEmoji("✅").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`perm:deny:${requestId}`).setLabel("Deny")
        .setEmoji("❌").setStyle(ButtonStyle.Danger),
    )
    const content = `🔐 Permission request: \`${toolName}\``
    for (const uid of userIds) {
      try {
        const u = await this.client.users.fetch(uid)
        await u.send({ content, components: [row] })
      } catch (e) {
        process.stderr.write(`gateway: permission prompt to ${uid} failed: ${e}\n`)
      }
    }
  }
```

In `start()`, register a button handler (before `this.client.login`):
```ts
    this.client.on("interactionCreate", async (interaction: Interaction) => {
      if (!interaction.isButton()) return
      const m = /^perm:(allow|deny):(.+)$/.exec(interaction.customId)
      if (!m) return
      if (!this.isAuthorized(interaction.user.id)) {
        await interaction.reply({ content: "Not authorized.", ephemeral: true }).catch(() => {})
        return
      }
      const behavior = m[1] as "allow" | "deny"
      this.permButtonCb(m[2], behavior)
      const label = behavior === "allow" ? "✅ Allowed" : "❌ Denied"
      await interaction.update({
        content: `${interaction.message.content}\n\n${label}`, components: [],
      }).catch(() => {})
    })
```

- [ ] **Step 6: Wire it all in `hub/index.ts`**

Add imports:
```ts
import { PermissionRouter } from "./permissions"
```

After `const dispatcher = new Dispatcher(transports)` and the `shims` record exist, add:
```ts
const permRouter = new PermissionRouter()

// Only allowlisted users may answer permission prompts.
gateway.setPermissionAuthorizer(uid => baseGate.listAllowed().includes(uid))

// A persistent agent's shim raised a tool-permission request → prompt the allowlist.
for (const [name, shim] of Object.entries(shims)) {
  shim.onPermissionRequest(req => {
    permRouter.register(req.requestId, name)
    void gateway.sendPermissionPrompt(baseGate.listAllowed(), req.requestId, req.toolName)
  })
}

// A button click → route the answer back to the originating agent's shim.
gateway.onPermissionButton((requestId, behavior) => {
  const agent = permRouter.resolve(requestId)
  if (agent) shims[agent]?.sendPermissionResult(requestId, behavior)
})
```

> `baseGate` must be constructed before this block — in the v1 entrypoint it is created as `const baseGate = new BaseGate(join(hub.stateDir, "access.json"))`. If that line currently sits below the orchestrator, move it up so it exists here. Keep a single `baseGate` instance shared by the orchestrator dep and this wiring.

Add the `resolvePermission` dep to the Orchestrator construction (text-reply path):
```ts
const orchestrator = new Orchestrator(hub, agents, {
  baseGate: (userId, chatId, isDM) => baseGate.gate(userId, chatId, isDM, Date.now()),
  resolvePermission: (code, behavior) => {
    const agent = permRouter.resolve(code)
    if (!agent) return false
    shims[agent]?.sendPermissionResult(code, behavior)
    return true
  },
  resolveRoles: id => gateway.resolveRoles(id),
  // ...rest unchanged
})
```

- [ ] **Step 7: Typecheck + full compile check**

Run: `bun run typecheck && bun build ./hub/index.ts --target bun --outfile /tmp/sb-g2-check.js`
Expected: typecheck clean; build bundles with no errors.

- [ ] **Step 8: Run the full suite**

Run: `bun test`
Expected: still green (74 pass — gateway/index discord.js paths are not unit-tested; the baseGate test adds 1 → 75). Confirm the actual count and report it.

- [ ] **Step 9: Commit**

```bash
git add hub/baseGate.ts tests/baseGate.test.ts hub/gateway.ts hub/index.ts
git commit -m "feat: wire interactive permission relay into hub (prompt + buttons + text reply)"
```

---

## Task G3: Pairing confirmation + stateDir single source of truth

**Files:**
- Create: `hub/approvals.ts`
- Test: `tests/approvals.test.ts`
- Modify: `scripts/pair.ts`
- Modify: `hub/index.ts` (poll approvals)
- Modify: `scripts/start-agent.sh`

- [ ] **Step 1: Write the failing test** — `tests/approvals.test.ts`

```ts
import { test, expect } from "bun:test"
import { writeApproval, drainApprovals } from "../hub/approvals"
import { mkdtempSync, existsSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

test("writeApproval then drainApprovals returns the pending confirmations and clears them", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-appr-"))
  writeApproval(dir, "user1", "chanA")
  writeApproval(dir, "user2", "chanB")
  const first = drainApprovals(dir).sort((a, b) => a.userId.localeCompare(b.userId))
  expect(first).toEqual([
    { userId: "user1", chatId: "chanA" },
    { userId: "user2", chatId: "chanB" },
  ])
  // second drain is empty (markers consumed)
  expect(drainApprovals(dir)).toEqual([])
})

test("drainApprovals on a missing dir returns empty", () => {
  expect(drainApprovals(join(tmpdir(), "sb-nope-does-not-exist"))).toEqual([])
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/approvals.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `hub/approvals.ts`**

```ts
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from "fs"
import { join } from "path"

const APPROVED_SUBDIR = "approved"

/** Operator side (pair.ts): drop a marker so the hub can DM the user a confirmation. */
export function writeApproval(stateDir: string, userId: string, chatId: string): void {
  const dir = join(stateDir, APPROVED_SUBDIR)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, userId), chatId)
}

/** Hub side: read + delete all pending approval markers. */
export function drainApprovals(stateDir: string): { userId: string; chatId: string }[] {
  const dir = join(stateDir, APPROVED_SUBDIR)
  let files: string[]
  try { files = readdirSync(dir) } catch { return [] }
  const out: { userId: string; chatId: string }[] = []
  for (const userId of files) {
    const path = join(dir, userId)
    try {
      const chatId = readFileSync(path, "utf8").trim()
      if (chatId) out.push({ userId, chatId })
    } catch { /* skip unreadable */ }
    rmSync(path, { force: true })
  }
  return out
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test tests/approvals.test.ts`
Expected: 2 pass.

- [ ] **Step 5: Update `scripts/pair.ts`** to read stateDir from config and write the marker

```ts
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
```

- [ ] **Step 6: Poll approvals in `hub/index.ts`** — after the gateway starts, add:

```ts
import { drainApprovals } from "./approvals"
// ...after `await gateway.start(token)`:
setInterval(() => {
  for (const { chatId } of drainApprovals(hub.stateDir)) {
    void gateway.sendPlain(chatId, "✅ Paired! You can talk to the agents now. Try `!agents`.")
  }
}, 5000).unref()
```

- [ ] **Step 7: Make `scripts/start-agent.sh` derive stateDir from config**

Replace the `STATE_DIR=...` line with a config-derived value (falls back to env, then default):

```bash
CONFIG_DIR="${SWITCHBOARD_CONFIG:-$REPO_DIR/config}"
STATE_DIR="${SWITCHBOARD_STATE_DIR:-$(bun -e "import {loadConfigs} from '$REPO_DIR/hub/config.ts'; console.log(loadConfigs('$CONFIG_DIR').hub.stateDir)" 2>/dev/null || echo "$HOME/.switchboard")}"
```

> `REPO_DIR` is already computed at the top of the script. This makes the socket path the script passes (`$STATE_DIR/${AGENT}.sock`) match the hub's `join(hub.stateDir, "${name}.sock")` even when `stateDir` is customized in `hub.config.json`.

- [ ] **Step 8: Typecheck + full suite**

Run: `bun run typecheck && bun test`
Expected: typecheck clean; suite green (adds 2 approvals tests → 77). Report the actual count.

- [ ] **Step 9: Commit**

```bash
git add hub/approvals.ts tests/approvals.test.ts scripts/pair.ts hub/index.ts scripts/start-agent.sh
git commit -m "feat: Discord pairing confirmation via approved-dir poller + stateDir single source"
```

---

## Task G4: Docs refresh

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the "Status of features" section** — move the permission relay from "Known v1 gap" to "Working", and update the pairing note (the user now gets a Discord confirmation). Leave "Manual Discord E2E pending" as the remaining open item.

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: permission relay + pairing confirmation now wired"
```

---

## Self-review (coverage)

- Final-review IMPORTANT gap (permission relay not connected) → Tasks G1 + G2.
- Final-review MINOR (pairing confirmation missing) → Task G3 (approved-dir poller).
- Final-review MINOR (stateDir dual source) → Task G3 (pair.ts + start-agent.sh read config).
- Remaining open item: manual Discord E2E (needs a real bot token — operator task, plan Task 19).
