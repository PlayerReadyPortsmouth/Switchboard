/** Per-agent environment scoping.
 *
 *  Both provider transports spawn their agent with `{...process.env}`, so every
 *  agent inherits every variable the hub holds — including whatever
 *  `<stateDir>/.env` loaded. On a hub running agents at different trust levels
 *  that makes `allowedTools` the only boundary, and it is not one: `Read` takes
 *  an absolute path, so a "read-only" agent can open a credentials file and take
 *  everything without running a single command.
 *
 *  This module lets an agent declare what it should see. It is opt-in and the
 *  default is exactly today's behaviour, so a hub that configures nothing is
 *  byte-identical to before.
 *
 *  Resolution, later wins:
 *    1. passthrough-filtered hub environment   (`envPassthrough`, default all)
 *    2. the agent's own env file               (`envFile`)
 *    3. inline values                          (`env`)
 *    4. hub-injected values                    (HUB_SOCKET, AGENT_NAME — never overridable)
 */
import { readFileSync } from "fs"

/** Variables a process needs before it can do anything at all. Kept even when a
 *  narrow passthrough list is given, because an agent that cannot find `claude`
 *  on PATH is a broken agent rather than a contained one. Any of these can still
 *  be overridden explicitly through `envFile` or `env`. */
export const ENV_ESSENTIALS = ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TERM", "TZ", "TMPDIR"]

export interface AgentEnvSpec {
  /** Names to inherit from the hub's environment. `["*"]` (the default) inherits
   *  everything, which is what every hub did before this existed. */
  envPassthrough?: string[]
  /** Path to a KEY=value file read for this agent alone. `~` is expanded by the
   *  caller (config.ts does this for every other path). */
  envFile?: string
  /** Inline values for this agent. Highest precedence below the hub's own. */
  env?: Record<string, string>
}

/** Parse KEY=value lines. Blank lines, `#` comments and `export ` prefixes are
 *  tolerated; a surrounding pair of quotes is stripped. Deliberately the same
 *  minimal shape as `hub/env.ts`, not a full dotenv implementation. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const m = line.replace(/^export\s+/, "").match(/^(\w+)\s*=\s*(.*)$/)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[m[1]] = v
  }
  return out
}

/** Build the environment one agent is spawned with.
 *
 *  @param spec      the agent's runtime env configuration
 *  @param hubEnv    the hub's own environment (normally `process.env`)
 *  @param injected  hub-controlled values that always win (HUB_SOCKET, AGENT_NAME)
 *  @param readFile  injectable for tests
 */
export function buildAgentEnv(
  spec: AgentEnvSpec | undefined,
  hubEnv: Record<string, string | undefined>,
  injected: Record<string, string> = {},
  readFile: (p: string) => string = (p) => readFileSync(p, "utf8"),
): Record<string, string> {
  const passthrough = spec?.envPassthrough
  const inheritAll = !passthrough || passthrough.includes("*")

  const out: Record<string, string> = {}
  if (inheritAll) {
    for (const [k, v] of Object.entries(hubEnv)) if (v !== undefined) out[k] = v
  } else {
    for (const k of [...ENV_ESSENTIALS, ...passthrough]) {
      const v = hubEnv[k]
      if (v !== undefined) out[k] = v
    }
  }

  if (spec?.envFile) {
    // A declared env file that cannot be read is a configuration error, not a
    // reason to silently hand the agent the hub's environment instead.
    let text: string
    try {
      text = readFile(spec.envFile)
    } catch (e) {
      throw new Error(`agent envFile ${spec.envFile} could not be read: ${(e as Error).message}`)
    }
    Object.assign(out, parseEnvFile(text))
  }

  if (spec?.env) Object.assign(out, spec.env)

  // Hub-injected last: an agent must not be able to point its own shim socket
  // somewhere else or rename itself by setting AGENT_NAME in its env file.
  Object.assign(out, injected)
  return out
}
