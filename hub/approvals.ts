import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from "fs"
import { join } from "path"

const APPROVED_SUBDIR = "approved"

/** Operator side (pair.ts): drop a marker so the hub can DM the user a confirmation. */
export function writeApproval(stateDir: string, userId: string, chatId: string): void {
  const dir = join(stateDir, APPROVED_SUBDIR)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, userId), chatId)
}

/** Hub side: read + delete all pending approval markers. */
export function drainApprovals(stateDir: string): { userId: string; chatId: string }[] {
  const dir = join(stateDir, APPROVED_SUBDIR)
  let files: string[]
  try { files = readdirSync(dir) } catch { return [] }
  const out: { userId: string; chatId: string }[] = []
  for (const userId of files) {
    const path = join(dir, userId)
    try {
      const chatId = readFileSync(path, "utf8").trim()
      if (chatId) out.push({ userId, chatId })
    } catch { /* skip unreadable */ }
    rmSync(path, { force: true })
  }
  return out
}
