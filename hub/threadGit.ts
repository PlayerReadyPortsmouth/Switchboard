export type GitExec = (argv: string[], cwd: string) => Promise<{ code: number; stdout: string; stderr: string }>

/** Real git executor: Bun.spawn against `git`, cwd = the base repo (for add) or
 *  the worktree itself (for status/remove). */
export const bunGitExec: GitExec = async (argv, cwd) => {
  const proc = Bun.spawn(["git", ...argv], { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code: code ?? 0, stdout, stderr }
}

/** Create a detached-HEAD worktree at `worktreePath` from `baseCwd`'s current
 *  commit. Detached (not a new branch) so concurrent threads never collide on
 *  branch names or mutate the base repo's branch state. */
export async function addWorktree(
  exec: GitExec, baseCwd: string, worktreePath: string,
): Promise<{ ok: boolean; error?: string }> {
  const r = await exec(["worktree", "add", "--detach", worktreePath, "HEAD"], baseCwd)
  return r.code === 0 ? { ok: true } : { ok: false, error: r.stderr.trim() || r.stdout.trim() }
}

/** Remove a worktree, but only if it's clean. A dirty worktree is left in place
 *  (dirty: true) rather than force-removed, so in-progress work is never
 *  silently discarded. */
export async function removeWorktree(
  exec: GitExec, worktreePath: string,
): Promise<{ ok: boolean; dirty?: boolean; error?: string }> {
  const status = await exec(["status", "--porcelain"], worktreePath)
  if (status.code !== 0) return { ok: false, error: status.stderr.trim() || "git status failed" }
  if (status.stdout.trim().length > 0) return { ok: false, dirty: true }
  const rm = await exec(["worktree", "remove", worktreePath], worktreePath)
  return rm.code === 0 ? { ok: true } : { ok: false, error: rm.stderr.trim() || rm.stdout.trim() }
}
