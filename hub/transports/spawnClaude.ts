import type { HeadlessRunner } from "./headless"
import type { ClaudeRunner } from "../router"

/** Real headless runner: spawns the claude CLI, feeds stdin, enforces a timeout. */
export function makeHeadlessRunner(bin = "claude"): HeadlessRunner {
  return async (args, stdin, cwd, timeoutMs) => {
    const proc = Bun.spawn([bin, ...args], { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
    proc.stdin.write(stdin); proc.stdin.end()
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => { proc.kill(); reject(new Error(`claude timed out after ${timeoutMs}ms`)) }, timeoutMs)
    )
    try {
      const stdout = await Promise.race([
        new Response(proc.stdout).text(),
        timeoutPromise,
      ])
      const code = await proc.exited
      if (code !== 0) throw new Error(`claude exited ${code}`)
      return { stdout }
    } finally {
      // ensure process is cleaned up if we get here via timeout path
    }
  }
}

/** Router runner: same spawn, text output, used by hub/router.ts route(). */
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
