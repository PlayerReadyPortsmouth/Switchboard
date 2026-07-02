import { test, expect } from "bun:test"
import { addWorktree, removeWorktree, type GitExec } from "./threadGit"

type RecordedCall = { argv: string[]; cwd: string }

function fakeExec(
  responses: Record<string, { code: number; stdout: string; stderr: string }>,
): { exec: GitExec; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const exec: GitExec = async (argv, cwd) => {
    calls.push({ argv, cwd })
    const key = argv.join(" ")
    return responses[key] ?? { code: 1, stdout: "", stderr: `unexpected: ${key}` }
  }
  return { exec, calls }
}

test("addWorktree succeeds when git exits 0", async () => {
  const { exec } = fakeExec({ "worktree add --detach /wt/t1 HEAD": { code: 0, stdout: "", stderr: "" } })
  const r = await addWorktree(exec, "/repo", "/wt/t1")
  expect(r.ok).toBe(true)
})

test("addWorktree surfaces the error when git fails", async () => {
  const { exec } = fakeExec({ "worktree add --detach /wt/t1 HEAD": { code: 128, stdout: "", stderr: "fatal: already exists" } })
  const r = await addWorktree(exec, "/repo", "/wt/t1")
  expect(r.ok).toBe(false)
  expect(r.error).toContain("already exists")
})

test("removeWorktree is a no-op success path when the worktree is clean", async () => {
  const { exec } = fakeExec({
    "status --porcelain": { code: 0, stdout: "", stderr: "" },
    "worktree remove /repo/.threads/t1": { code: 0, stdout: "", stderr: "" },
  })
  const r = await removeWorktree(exec, "/repo/.threads/t1")
  expect(r.ok).toBe(true)
})

test("removeWorktree refuses when the worktree has uncommitted changes", async () => {
  const { exec } = fakeExec({ "status --porcelain": { code: 0, stdout: " M some/file.ts\n", stderr: "" } })
  const r = await removeWorktree(exec, "/wt/t1")
  expect(r.ok).toBe(false)
  expect(r.dirty).toBe(true)
})

test("removeWorktree's status check runs with cwd = the worktree itself", async () => {
  const { exec, calls } = fakeExec({
    "status --porcelain": { code: 0, stdout: "", stderr: "" },
    "worktree remove /repo/.threads/t1": { code: 0, stdout: "", stderr: "" },
  })
  await removeWorktree(exec, "/repo/.threads/t1")
  const statusCall = calls.find((c) => c.argv.join(" ") === "status --porcelain")
  expect(statusCall?.cwd).toBe("/repo/.threads/t1")
})

test("removeWorktree's git worktree remove runs from the base repo, not the worktree being deleted", async () => {
  const { exec, calls } = fakeExec({
    "status --porcelain": { code: 0, stdout: "", stderr: "" },
    "worktree remove /repo/.threads/t1": { code: 0, stdout: "", stderr: "" },
  })
  await removeWorktree(exec, "/repo/.threads/t1")
  const removeCall = calls.find((c) => c.argv.join(" ") === "worktree remove /repo/.threads/t1")
  expect(removeCall?.cwd).toBe("/repo")
})
