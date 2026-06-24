import type { CardSpec, DirectCommand, DirectExec } from "./types"

/** Result of running a command's exec step: raw text + parsed JSON if it parsed. */
export interface ExecResult { text: string; json?: any }
/** Injected IO seam (shell/HTTP); real impl lives in index.ts, fakes in tests. */
export type DirectExecutor = (spec: DirectExec, args: string) => Promise<ExecResult>

/** What the hub should emit for a matched direct command. */
export type DirectOutcome =
  | { kind: "agent"; agent: string; content: string }   // format-bridge: hand to an agent
  | { kind: "text"; text: string }
  | { kind: "card"; card: CardSpec }

/** Find the first command whose keyword matches `content` (exact, or as a prefix
 *  with trailing args). Returns the command + the trailing arg string. */
export function matchDirectCommand(
  content: string, cmds: DirectCommand[],
): { cmd: DirectCommand; args: string } | null {
  const trimmed = content.trim()
  for (const cmd of cmds) {
    if (trimmed === cmd.match) return { cmd, args: "" }
    if (trimmed.startsWith(cmd.match + " ")) return { cmd, args: trimmed.slice(cmd.match.length + 1).trim() }
  }
  return null
}

/** Interpolate `$args` (whole arg string) and `$1`,`$2`… (whitespace-split args). */
export function interpolateArgs(tmpl: string, args: string): string {
  const parts = args.length ? args.split(/\s+/) : []
  return tmpl.replace(/\$(args|\d+)/g, (_, tok: string) => (tok === "args" ? args : parts[Number(tok) - 1] ?? ""))
}

function getPath(obj: any, path: string): unknown {
  return path.split(".").reduce<any>((o, k) => (o == null ? undefined : o[k]), obj)
}

/** Format a template: `$args`/`$N` from args, then `{{json.path}}` from parsed JSON. */
export function renderTemplate(template: string, result: ExecResult, args: string): string {
  return interpolateArgs(template, args).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
    const v = getPath(result.json, path)
    return v == null ? "" : String(v)
  })
}

/** Run a matched direct command: exec → format. With `formatAgent`, hand the raw
 *  result to that agent (Tier B+A bridge); otherwise template/raw → text or card. */
export async function runDirect(
  cmd: DirectCommand, args: string, exec: DirectExecutor,
): Promise<DirectOutcome> {
  const result = await exec(cmd.exec, args)
  if (cmd.formatAgent) {
    const preamble = cmd.template
      ? interpolateArgs(cmd.template, args)
      : "Format this result for the user, concisely:"
    return { kind: "agent", agent: cmd.formatAgent, content: `${preamble}\n\n${result.text}` }
  }
  const body = cmd.template ? renderTemplate(cmd.template, result, args) : result.text
  if (cmd.render === "card") return { kind: "card", card: { title: cmd.cardTitle ?? cmd.match, body, buttons: [] } }
  return { kind: "text", text: body }
}
