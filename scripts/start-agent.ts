#!/usr/bin/env bun
// Launch a persistent Switchboard agent: a `claude --channels` session whose
// channel server is the Switchboard shim, pointed at this agent's hub socket.
//
// Unlike a bare `claude --channels`, this applies the agent's configured
// `model` / `appendSystemPrompt` / `claudeArgs` from config/agents.json and
// loads <stateDir>/.env, so a persistent agent gets the same system prompt and
// hub-side environment (tokens, API config) that the schema already documents.
import { join } from "path"
import { existsSync } from "fs"
import { loadConfigs } from "../hub/config"
import { config as loadEnv } from "../hub/env"
import type { AgentConfig } from "../hub/types"

/** Build the argv passed to `claude` for a persistent agent (pure, testable). */
export function buildAgentArgv(
  shimCommand: string,
  cfg: AgentConfig | undefined,
  passthrough: string[],
): string[] {
  const args = ["--channels", `command:${shimCommand}`]
  const rt = cfg?.runtime
  if (rt?.model) args.push("--model", rt.model)
  if (rt?.appendSystemPrompt) args.push("--append-system-prompt", rt.appendSystemPrompt)
  if (rt?.claudeArgs?.length) args.push(...rt.claudeArgs)
  args.push(...passthrough)
  return args
}

if (import.meta.main) {
  const agent = process.argv[2]
  if (!agent) {
    process.stderr.write("usage: start-agent.ts <agent-name> [extra claude args...]\n")
    process.exit(1)
  }
  const passthrough = process.argv.slice(3)
  const repoDir = join(import.meta.dir, "..")
  const configDir = process.env.SWITCHBOARD_CONFIG ?? join(repoDir, "config")

  const { hub, agents } = loadConfigs(configDir)
  const cfg = agents[agent]
  if (!cfg) {
    process.stderr.write(`start-agent: agent "${agent}" is not in the registry\n`)
    process.exit(1)
  }

  // Load <stateDir>/.env so the agent inherits the same env the hub does.
  loadEnv(join(hub.stateDir, ".env"))

  const socket = join(hub.stateDir, `${agent}.sock`)
  if (!existsSync(socket)) {
    process.stderr.write(`hub socket ${socket} not found — start the hub first (bun run hub)\n`)
    process.exit(1)
  }

  const shimCommand = `bun run ${join(repoDir, "shim", "server.ts")}`
  const argv = buildAgentArgv(shimCommand, cfg, passthrough)
  const proc = Bun.spawn(["claude", ...argv], {
    cwd: cfg.runtime.cwd,
    env: { ...process.env, HUB_SOCKET: socket, AGENT_NAME: agent },
    stdin: "inherit", stdout: "inherit", stderr: "inherit",
  })
  // Forward termination signals to the child so pm2/systemd stop it cleanly.
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => { try { proc.kill() } catch {} })
  }
  process.exit(await proc.exited)
}
