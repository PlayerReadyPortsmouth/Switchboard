import { test, expect } from "bun:test"
import { pendingApprovalsToJson, buildWebInboundMessage, formatMirrorLine } from "./webActions"
import { formatWebMirrorLine } from "./displayName"
import type { PendingApproval } from "./approval"

test("pendingApprovalsToJson projects the fields the panel needs, drops `fire`/`state`", () => {
  const e: PendingApproval = {
    id: "appr-1", kind: "outbound", target: "route-a", actor: "hub", chat: "chan-1",
    summary: "POST → route-a", createdAt: 100, expiresAt: 200, state: "pending", fire: () => {},
  }
  expect(pendingApprovalsToJson([e])).toEqual([{
    id: "appr-1", kind: "outbound", target: "route-a", actor: "hub", chat: "chan-1",
    summary: "POST → route-a", createdAt: 100, expiresAt: 200,
  }])
})

test("buildWebInboundMessage tags the actor as web:<email> and isn't a DM", () => {
  const m = buildWebInboundMessage("chan-1", "aurora@player-ready.co.uk", "hello", 1000, () => "web-1")
  expect(m).toEqual({
    chatId: "chan-1", messageId: "web-1", userId: "web:aurora@player-ready.co.uk",
    user: "aurora@player-ready.co.uk", content: "hello", ts: new Date(1000).toISOString(), isDM: false,
  })
})

test("formatMirrorLine shares the one web-mirror convention with the surface adapter", () => {
  expect(formatMirrorLine("aurora@player-ready.co.uk", "hello")).toBe("🌐 **Aurora** · hello")
  expect(formatMirrorLine("Aurora.Nicholas@player-ready.co.uk", "hello")).toBe("🌐 **Aurora N.** · hello")
  // Same output as the conversations path builds for the same author/content.
  expect(formatMirrorLine("aurora.nicholas@player-ready.co.uk", "hello"))
    .toBe(formatWebMirrorLine("aurora.nicholas@player-ready.co.uk", "hello"))
})
