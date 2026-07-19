# Switchboard — project memory for Claude Code

One Discord bot fanned out to many Claude Code agents. A single Bun **hub** process owns the
bot token/gateway, routes each message via a Haiku router to a persistent or ephemeral
`claude -p --input-format stream-json` session, and gives agents rich Discord powers
(cards, modals, attachments, share links, memory, consult) through a per-agent MCP **shim**
talking back over a local socket.

## Commands (run from repo root)

```bash
bun install            # deps
bun test               # unit suite (~680 tests, <3s)
bun run typecheck      # tsc --noEmit — keep clean
bun run hub            # run the hub (needs config/agents.json + DISCORD_BOT_TOKEN, see README Setup)
bun run scripts/smoke-streamjson.ts   # transport check against a REAL `claude` CLI
bun run scripts/smoke-codex-app-server.ts # authenticated two-turn Codex app-server check
bun run scripts/pair.ts <code>        # approve a DM pairing code
```

- No build step: TypeScript run directly by Bun, ESM (`"type": "module"`).
- **Windows dev box gotcha:** `bun test` has **5 known failures** here, all in
  `hub/documents.test.ts` — that file's fake IO hardcodes `/` as the path separator, so its
  simulated `rename` silently no-ops on Windows and later assertions read `undefined`. Proven
  environment-only: the same commit runs that file 7/7 green on the Linux box. Those 5 are the
  green baseline on Windows; fully green on Linux (where prod runs). Any other failure is yours.
  (An older `tests/config.test.ts` "expandHome" failure was documented here for a long time
  after it stopped occurring — it now passes. Don't hunt for it.)
  Measure the baseline on a clean tree first and **diff failure sets by name**, not by count —
  trusting the count is exactly how the stale entry above survived so long.
  Scary stderr lines like "qdrant down" / "disk full" are intentional failure-injection tests,
  not problems.
- Production hub runs live as a Discord bot on a Linux VPS (Unix domain socket for the shim),
  so runtime behaviour must be Linux-correct; Windows is fine for tests/typecheck.

## Config & secrets

- `config/hub.config.json` — tracked, the real hub config **locally**. `config/agents.json` —
  git-ignored agent registry; copy from `config/agents.example.json` before first run or boot
  throws. `SWITCHBOARD_CONFIG` env var overrides the config dir.
- **In production that override is set, and it catches people out.** The live launcher
  (`~/.switchboard/run-hub.sh`) sets `SWITCHBOARD_CONFIG=/srv/ready-switchboard/config`, so the
  hub reads `/srv/ready-switchboard/config/hub.config.json` — a hand-managed, **non-git**
  directory with dated `.bak-<label>-<date>` files. The `config/` inside the deployed repo at
  `/srv/switchboard` is a template the running hub never loads: editing it changes nothing.
  Edit the live file, snapshot it first, and validate the JSON parses before restarting.
- Secrets never live in config — config holds **env-var names** (`secretEnv`, `botTokenEnv`);
  values go in `<stateDir>/.env` (default `~/.switchboard/.env`).
- **Every key documented:** [`docs/config-reference.md`](docs/config-reference.md) — config
  loading, hot-reload tiers, access-control layering, share-link internals. Trust it, but it's
  a dated snapshot; re-derive from `hub/config.ts` / `hub/types.ts` on conflict.
- Shim feature gates (`CONSULT`, `ATTACH_FILES`, `PUBLISH_LINK`, `PEERING`, `RECEIPTS`) are
  env vars **injected by the hub at agent spawn** — setting them in your shell does nothing.

## Architecture map (hub/, flat files)

| Area | Files |
|---|---|
| Entry / wiring | `index.ts` (2.3k lines — all subsystem wiring lives here) |
| Discord I/O | `gateway.ts`, `outbound.ts`, `format.ts`, `messageCache.ts` |
| Access layers (in order) | `baseGate.ts` (DM pairing / group opt-in) → `access.ts` (per-agent roles/users) → feature flags → `deployGate.ts` (`deploy:*` buttons) → `gatedActions.ts` + `approvals.ts` (park-for-Approve/Deny) |
| Routing | `router.ts` (Haiku pick), `bindings.ts` (sticky), `orchestrator.ts` |
| Agent sessions | `transports/streamJson.ts` (Claude), `transports/codexAppServer.ts` + `codexAppServerFraming.ts` (Codex), `transports/provider.ts`, `transports/spawnClaude.ts`, `turnGate.ts` (one turn in flight), `sessionGovernor.ts`, `agentPool.ts`, `threadAgents.ts`/`threadGit.ts`/`threadState.ts` (per-Discord-thread instances + worktrees) |
| Shim relay | `transports/shimSocket.ts` ↔ `shim/server.ts` (the agent-facing MCP toolset) |
| Cards / UI | `cardRegistry.ts`, `cardLifecycle.ts`, `modal.ts`, `notifyRouter.ts` |
| Memory vault | `memory/` (store, retriever, embedder, librarian, distiller, dedup, gardener, qdrant/http backends), `memoryBrowse.ts` |
| Observability | `audit.ts`/`auditLog.ts`/`auditCommand.ts`, `turnTrace.ts`/`traceSweep.ts`, `metrics.ts`/`metricsServer.ts`, `statusRegistry.ts`/`statusBoard.ts`, `toolUsageRegistry.ts`, `doctor.ts`, `replay.ts` |
| Web dashboard + command panel | `web.ts` (the whole page), `webServer.ts`, `webActions.ts`, `hubConfigDraft.ts`/`hubConfigPreview.ts`, `agentConfigDraft.ts`/`agentConfigPreview.ts` |
| Integrations | `webhookListener.ts` (inbound), `outboundDelivery.ts`, `scheduler.ts`, `directCommands.ts`, `commandActions.ts`, `workflow.ts` (missions), `consult.ts`, `peering.ts`/`peerClient.ts`/`peerRoutes.ts`/`peerSpool.ts` (cross-VPS), `escalation.ts`, `overseer.ts` |

`README.md` is the feature-by-feature deep dive and is kept current — read the relevant
section before touching a subsystem.

## Conventions

- **Spec-first:** every feature has a design spec in `docs/superpowers/specs/` and usually a
  plan in `docs/superpowers/plans/` (dated filenames). Write/update the spec for non-trivial
  work; git history shows `docs:` spec/plan commits preceding `feat:` commits.
- **Tests:** new tests go **next to the module** (`hub/foo.test.ts`); the older suite lives in
  `tests/`. Both are picked up by `bun test`. Tests inject IO (fs/exec/clock/fetch as function
  params) — no network, no Discord, no real `claude` in unit tests; real-CLI checks are the
  `scripts/smoke-*.ts` scripts.
- **Everything off by default:** new subsystems ship behind a config gate (`enabled: false` /
  key absent = off) and must be byte-identical to before when off. Follow this pattern.
- **Fail closed, never throw on the hot path:** audit `record()` never throws; approvals expire
  unfired; malformed metadata is kept, not reaped. Match this defensive style.
- **Commit style:** `feat(scope):` / `fix(scope):` / `docs:` / `test(web):`; feature branches
  → PRs on GitHub (`PlayerReadyPortsmouth`, default branch `master`).

## Gotchas

- `DASHBOARD_HTML` in `hub/web.ts` is one giant template literal containing nested `<script>`
  JS — literal newlines inside its *nested* JS strings must be escaped (`\\n`), an unescaped
  one broke the dashboard for ~2 hours once. A test asserts the script block parses; keep it.
- Hub config hot-swap "safe keys" are exactly the 7 listed in `hub/hubConfigDraft.ts`;
  everything else needs a hard reload or full restart (`hub/configReload.ts` classifies).
- `EXCLUDED_HUB_CONFIG_KEYS` in `hub/index.ts` strips token/socket/state/guild keys from every
  web-editor response — never let a new web route leak them.
- The web dashboard and `/metrics` are **unauthenticated**, loopback-bound by default. Don't
  add write endpoints without going through the preview→confirm + audit pattern.
- Agents run `--dangerously-skip-permissions`; the safety model is config gates + audit +
  approvals, not tool permissions. Treat `consultableBy`/`peerableBy` as data-flow grants.
- `hub/turnGate.ts` is a concurrency gate, not a permission gate.
- **`bun run build:web` needs `SWITCHBOARD_WEB_BASE` in production, and fails silently without
  it.** The SPA is served at `readyapp.player-ready.co.uk/switchboard/`, so it must be built as
  `SWITCHBOARD_WEB_BASE=/switchboard bun run build:web`. Unset, the base defaults to `/` and
  assets emit as `/chunk-*.js`; those fall through the reverse proxy's catch-all to **ReadyApp's**
  bundle, and the page renders blank with no error anywhere. Verify after every build:
  `grep -oE 'src="[^"]+"' dist/web/index.html` must show `/switchboard/chunk-*.js`, and the
  manifest must carry `"scope": "/switchboard/"`. The launcher runs `hub/index.ts` directly and
  does **not** build, so assets must be rebuilt explicitly after every code deploy.
- Web-only changes need a rebuild but **not** a restart — `createBuiltWorkspaceAssets` reads from
  disk per request, so no process bounce and no disruption to in-flight agent turns.
- Probing the hub directly with the `/switchboard` prefix (e.g. `127.0.0.1:8080/switchboard/chunk-*.js`)
  returns 503 `workspace_not_built`. That is **correct** — the proxy strips the prefix before
  forwarding, so the hub serves assets unprefixed. Two separate deploys mistook this for a fault.

## How to work in this repo

Shared engineering practice lives in `~/Documents/Ready/ready-docs/engineering/` — read the relevant doc before starting that kind of work:

- [working-style.md](../ready-docs/engineering/working-style.md) — any task: scout first, right altitude, verify end-to-end, report outcome-first.
- [bug-hunting.md](../ready-docs/engineering/bug-hunting.md) — bugs: reproduce → root cause → fix the cause → regression test → verify.
- [coding-standards.md](../ready-docs/engineering/coding-standards.md) — style, comments, error handling, tests, dependencies.
- [shipping.md](../ready-docs/engineering/shipping.md) — feature-flag + canary rule, deploy conventions, ready-to-enable checklist.
- [agents-and-parallelism.md](../ready-docs/engineering/agents-and-parallelism.md) — when to use subagents; structure independent work to run in parallel.

**Repo-specific:**

- **Verification here:** `bun run typecheck` + `bun test` (expect only the 5 known Windows
  failures — see Commands). For transport/shim changes also run
  `bun run scripts/smoke-streamjson.ts` against a real `claude` (hardcodes a `/tmp` Unix
  socket — run it on the Linux box, not Windows).
- For Codex transport changes also run `bun run scripts/smoke-codex-app-server.ts`; it uses
  the pinned local CLI/auth and verifies two turns retain one app-server thread.
- Live-hub behaviour (Discord cards, buttons, modals) can only be confirmed on a running hub —
  say so explicitly if you couldn't drive it.
- **This repo's flag system is config gates:** new subsystems ship `enabled: false` / key
  absent = off, byte-identical to before when off. Spec first in `docs/superpowers/specs/`.
- `hub/index.ts` wiring changes deserve extra care — every subsystem meets there.
