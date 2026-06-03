import type { ClaudeRunner } from "../router"

/** Router runner: spawns the claude CLI in print mode, returns text output.
 *  Used by hub/router.ts route() to pick which agent a message reaches. */
export function makeRouterRunner(bin = "claude"): ClaudeRunner {
  return async (args, stdin) => {
    const proc = Bun.spawn([bin, ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
    proc.stdin.write(stdin); proc.stdin.end()
    const stdout = await new Response(proc.stdout).text()
    const code = await proc.exited
    if (code !== 0) throw new Error(`claude exited ${code}`)
    return stdout
  }
}
