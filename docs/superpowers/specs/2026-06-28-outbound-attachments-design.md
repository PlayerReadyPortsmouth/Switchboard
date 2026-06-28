# Outbound Attachments — Design

**Date:** 2026-06-28
**Status:** Approved, pending implementation plan

## Problem

Agents can produce files (a `.md` or `.pdf` report, a `.csv`, a chart) but have
no way to deliver them. The hub can already *send* a Discord message with file
attachments — `AgentReply.files` (`hub/types.ts`) is plumbed straight into
`gateway.sendReply` (`hub/gateway.ts`, `{ files }` on the first message) — but
nothing ever populates that field, so the capability is dormant. There is no
agent-facing mechanism to say "attach this file".

Meanwhile the *inbound* direction already works: `feat(attachments)` (a2c09ee)
downloads user uploads and folds their local paths into the turn. This spec adds
the symmetric outbound path.

## Goal

Give agents a single MCP tool to attach a file they have produced to a Discord
message, with tight containment so the new egress path cannot be used to
exfiltrate secrets.

Non-goals: attaching files fetched from arbitrary URLs; multi-file batching in a
single tool call; threading/parallel-agent work (tracked as a separate feature).

## Architecture

"Give the agents a tool" is near-literal here: the shim (`shim/server.ts`) is an
MCP server already exposing `post_card`, `edit_message`, `remember`, etc. We add
one more tool that maps to a new shim-socket wire frame, which the hub validates
and turns into a Discord message. Fire-and-forget, mirroring `post_card` — the
chosen **immediate, own-message** delivery model (no coupling to the transport's
reply construction).

Flow:

```
agent → attach_file(chat_id, path, caption?, filename?)        [shim/server.ts]
      → toolCallToWire → { t: "attach", chatId, path, caption, filename }
      → shim socket → attachCb                                  [hub/index.ts]
      → outboxAttach.resolve(agent, path)  (validate/contain)   [hub/outboxAttach.ts]
      → gateway.sendFiles(chatId, [absPath], caption, filename) [hub/gateway.ts]
      → Discord message carrying the file
```

## Components

### 1. Agent-facing MCP tool — `shim/server.ts`

New tool, listed **only when the feature is enabled** (same conditional pattern
as `ask_agent` under `CONSULT`). The shim is launched by Claude as an MCP server
and sees only the `env` block in its MCP config — NOT the hub's `process.env` —
so the `ATTACH_FILES=1` gate is injected through `buildShimMcpConfig`
(`hub/transports/streamJsonFraming.ts`), threaded from `attachEnabled:
!!hub.outboundAttachments?.enabled` exactly as `CONSULT` is. (An earlier draft set
`process.env.ATTACH_FILES` in the hub and relied on inheritance; that does not
reach the shim and was corrected before deploy.)

```
attach_file(chat_id, path, caption?, filename?)
```

- `path` — **relative to the agent's outbox** (e.g. `report.pdf`). Absolute
  paths and `..` are accepted by the shim but rejected hub-side; the validation
  authority is the hub, never the shim.
- `caption` — optional message text posted with the file.
- `filename` — optional display name; defaults to the basename of `path`.

Description instructs the agent: *write the file into your outbox first, then
attach it by relative path.* Maps via `toolCallToWire`:

```
{ t: "attach", chatId: args.chat_id, path: args.path,
  caption: args.caption, filename: args.filename }
```

Fire-and-forget: returns an immediate confirmation text frame (like `post_card`),
does not wait for delivery.

### 2. Path validation/containment — `hub/outboxAttach.ts` (new, pure)

The security core. Given `(agent, path, opts)`:

1. Compute `root = realpath(<outboxBase>/<agent>/)` (create the dir on demand).
2. Resolve the candidate as `realpath(join(root, path))`.
   - Using `realpath` on the resolved candidate means a **symlink whose target
     escapes the root is caught**, not just literal `..`.
3. Reject if the resolved path is not within `root` (prefix check on the
   canonicalised paths, with a trailing-separator guard so `/outbox/agentX`
   cannot match `/outbox/agentX-evil`).
4. Reject if missing / not a regular file.
5. Reject if `size > maxBytes`.
6. Reject if `allowedExtensions` is non-empty and the extension is not in it.

Returns a typed result: `{ ok: true, absPath, filename, size }` or
`{ ok: false, reason }` with an enumerated reason (`escape | missing | oversize |
extension | notfile`). No I/O to Discord here — pure and unit-testable, mirroring
how `hub/attachments.ts` isolates the inbound download logic.

### 3. Hub wiring — `hub/transports/shimSocket.ts` + `hub/index.ts`

- Add `attachCb` to the shim socket alongside the existing `editCb`, fired when a
  `{ t: "attach" }` frame arrives. The socket knows the registered `agent` (from
  the `register` frame), so the agent identity is taken from the connection — the
  agent cannot spoof another agent's outbox.
- In `index.ts`, wire `attachCb` to: call `outboxAttach.resolve`, and on success
  call `gateway.sendFiles`; on failure, log to stderr and post a brief
  channel-visible note so the agent/operator isn't left guessing (e.g.
  `⚠️ attach failed: <reason>`).
- Audit: record an `attach` effect in the audit ledger (actor `agent:<name>`,
  target chatId, outcome ok/deny + reason), consistent with other governed
  effects.

### 4. Gateway send — `hub/gateway.ts`

New `sendFiles(chatId, paths, caption?, filename?)`:

- Resolve the channel exactly as `sendReply`/`sendPlain` do (`"send" in ch`
  guard).
- Build Discord attachments from absolute paths (`AttachmentBuilder`),
  overriding the display name with `filename` when provided.
- Clamp to Discord's **max 10 files** per message (defensive; the tool sends one
  at a time, but the method takes an array).
- Post `{ content: caption, files }`. Reuses the same Discord file path that
  `sendReply` already relies on.

### 5. Config & flag — `hub/config.ts`

Per the project feature-flag rule (runtime flag, default off, byte-identical when
off):

```jsonc
hub.outboundAttachments: {
  enabled: false,                 // default off
  outboxDir: "<stateDir>/outbox", // per-agent subdir created on demand
  maxBytes: 8388608,              // 8 MB (Discord unboosted ceiling)
  allowedExtensions: []           // empty = allow any; e.g. ["md","pdf","png","csv"]
}
```

- Disabled → the tool is **not listed** to agents *and* any stray `attach` frame
  is ignored by the hub. Both gates, so an old shim cannot smuggle the frame in.
- Rollback: set `enabled: false` (or drop the key) and restart the hub.

## Error handling

- Invalid/contained-escape path → no send; stderr log + channel note + audit
  `deny`. The agent's turn is unaffected (fire-and-forget already returned).
- Oversize / wrong extension → same deny path with the specific reason.
- Discord send failure (network, perms) → caught in the gateway, logged; does not
  throw into the socket handler.
- Feature disabled but frame received → silently ignored (defensive double-gate).

## Security notes

Agents run with `--dangerously-skip-permissions`, so this tool is a genuine new
egress channel. **Be precise about what containment does and does not buy.** A
deliberately hostile agent already has full file access and can simply copy a
secret into its own outbox (`cat /etc/passwd > <outbox>/x.txt`) and attach
it — no `..`, symlink, or race needed. Path containment is therefore **not** an
exfiltration boundary against a hostile agent. Its real, narrower guarantees:

1. **Outbox containment** — the `realpath`-based prefix check defeats *accidental
   / confused-deputy* attachment of arbitrary host paths (`..` traversal,
   absolute paths, symlink-target escape). It forces an explicit copy into the
   outbox, which the audit ledger then records. Agent identity is the transport's
   `name`, never a tool arg, so one agent cannot name another's outbox.
2. **Size cap** — bounds accidental/abusive large dumps.
3. **Extension allowlist** (optional) — operators can restrict to document/image
   types if desired.

The genuine defenses against deliberate exfiltration are **agent trust** (only
enable for agents you trust on the box), the **audit trail** (every attach is
logged with the file + outcome), and the **extension allowlist**. The per-agent
outbox keeps one agent from reading another's *staged* files, but is not a
sandbox around the agent's own host access.

> **TOCTOU / delivery-audit hardening (done):** `resolveOutboxFile` now reads the
> validated file into a `Buffer` synchronously, immediately after the realpath
> containment check (no intervening `await`), and only that Buffer — never a path
> string — is handed to discord.js. This closes the window where a hostile agent
> could swap the validated file for an out-of-outbox symlink before discord.js's
> lazy read (I3). The handler also `await`s delivery and audits the *real*
> outcome, posting a "could not deliver" note and a `deny`/`delivery` audit row
> when the Discord send fails, so the ledger reflects delivery rather than mere
> dispatch (I2). **Known residual:** a microsecond cross-process race between the
> `statSync` and `readFileSync` syscalls remains (a fully bulletproof close would
> `open()` once and `fstat`+`read` the same fd); strictly weaker than the direct
> copy above and out of scope for the chosen threat model.

## Testing

- **`outboxAttach` unit tests (the security core):** traversal escape (`..`),
  symlink-target escape, sibling-prefix false match (`agentX` vs `agentX-evil`),
  missing file, non-regular file, oversize, extension reject, happy path.
  Mirrors `tests/attachments.test.ts` for the inbound side.
- **`toolCallToWire` mapping test** for `attach_file` → `{ t: "attach", … }`,
  alongside the existing shim tests in `shim/server.test.ts`.
- **Gateway `sendFiles`** exercised through the existing injectable-channel test
  seam used by the other `send*` methods.
- Full suite + typecheck must show no new failures vs baseline (per project
  convention — typecheck per task, not just vitest).

## Rollout

1. Land behind `outboundAttachments.enabled: false`.
2. Enable on a test/canary hub, have an agent write and attach a `.md`/`.pdf`.
3. Confirm containment by attempting an escape path in a controlled test.
4. Flip on for real once verified.
