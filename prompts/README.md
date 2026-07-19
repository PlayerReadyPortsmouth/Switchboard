# Agent prompts

Reference copies of the per-agent system prompts that the production hub runs.

## How these relate to what actually runs

The hub does **not** read this directory. Each agent's prompt is inlined at
`agents.<name>.runtime.appendSystemPrompt` in `config/agents.json` (git-ignored;
the live copy is `/srv/ready-switchboard/config/agents.json` on the VPS).

The VPS also keeps `/srv/ready-switchboard/prompts/<name>-agent.md` as a
human-readable mirror of that inlined string. The mirror is documentation only —
editing it changes nothing until the same text is written into `agents.json`.

So a prompt exists in up to three places, and **all three must be kept in step**:

| Location | Read by the hub? | Tracked in git? |
|---|---|---|
| `agents.<name>.runtime.appendSystemPrompt` in `config/agents.json` (VPS) | **yes** | no |
| `/srv/ready-switchboard/prompts/<name>-agent.md` (VPS) | no — mirror | no |
| `prompts/<name>-agent.md` (this directory) | no — reference | yes |

## Deploying a prompt change

Editing a prompt changes a **live agent's behaviour**. It takes effect only when
the new text reaches `agents.json` and the agent respawns.

1. Copy the new text into `runtime.appendSystemPrompt` for that agent in
   `/srv/ready-switchboard/config/agents.json` (JSON-escaped — write it with a
   script rather than by hand).
   ```bash
   # on the VPS, with the new text already at prompts/<name>-agent.md
   python3 - <<'PY'
   import json
   name = "assistant"
   cfg = "/srv/ready-switchboard/config/agents.json"
   text = open(f"/srv/ready-switchboard/prompts/{name}-agent.md").read().rstrip("\n")
   d = json.load(open(cfg))
   d[name]["runtime"]["appendSystemPrompt"] = text
   json.dump(d, open(cfg, "w"), indent=2, ensure_ascii=False)
   PY
   ```
2. Copy the same text to `/srv/ready-switchboard/prompts/<name>-agent.md` so the
   mirror does not drift. (The snippet above reads the mirror, so update the
   mirror first and the two cannot diverge.)
3. Respawn the agent so it picks up the new system prompt. `appendSystemPrompt`
   is part of the spawn signature (`hub/configReload.ts`), baked into the agent
   process's argv at spawn, so a running persistent agent keeps the old prompt
   until it is respawned. Send **`!reload hard`** in Discord: that re-reads
   `agents.json` and respawns exactly the persistent agents whose spawn config
   changed. A full hub restart is **not** required.

Card behaviour (embeds, buttons, modals) can only be confirmed on a running hub —
a prompt change cannot be verified by `bun test` or `bun run typecheck`.
