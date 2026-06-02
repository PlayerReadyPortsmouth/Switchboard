import { test, expect } from "bun:test"
import { writeApproval, drainApprovals } from "../hub/approvals"
import { mkdtempSync, existsSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

test("writeApproval then drainApprovals returns the pending confirmations and clears them", () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-appr-"))
  writeApproval(dir, "user1", "chanA")
  writeApproval(dir, "user2", "chanB")
  const first = drainApprovals(dir).sort((a, b) => a.userId.localeCompare(b.userId))
  expect(first).toEqual([
    { userId: "user1", chatId: "chanA" },
    { userId: "user2", chatId: "chanB" },
  ])
  // second drain is empty (markers consumed)
  expect(drainApprovals(dir)).toEqual([])
})

test("drainApprovals on a missing dir returns empty", () => {
  expect(drainApprovals(join(tmpdir(), "sb-nope-does-not-exist"))).toEqual([])
})
