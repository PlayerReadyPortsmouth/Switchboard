import { expect, test } from "bun:test"
import type { CardSpec } from "./types"
import type { ApprovalNotificationView } from "./approvalTypes"
import {
  DiscordApprovalNotificationPort,
  type DiscordApprovalNotificationGateway,
} from "./approvalDiscordNotifications"

function approvalView(overrides: Partial<ApprovalNotificationView> = {}): ApprovalNotificationView {
  return {
    id: "approval-1",
    version: "1",
    kind: "outbound",
    target: "deploy-done",
    summary: "POST to deploy-done",
    risk: "elevated",
    requestedBy: { surface: "agent", id: "assistant" },
    createdAt: 100,
    expiresAt: 1_000,
    terminalAt: null,
    state: "pending",
    decisionBy: null,
    decisionAt: null,
    outcomeReason: null,
    execution: "not_applicable",
    executionStartedAt: null,
    executionFinishedAt: null,
    ...overrides,
  }
}

function fakeGateway(options: { messageId?: string; editError?: Error } = {}) {
  const sent: Array<{ chatId: string; card: CardSpec }> = []
  const edited: Array<{ chatId: string; messageId: string; card: CardSpec }> = []
  const gateway: DiscordApprovalNotificationGateway = {
    async sendCard(chatId, card) {
      sent.push({ chatId, card })
      return options.messageId
    },
    async editCardOrThrow(chatId, messageId, card) {
      edited.push({ chatId, messageId, card })
      if (options.editError) throw options.editError
    },
  }
  return { gateway, sent, edited }
}

test("post returns an exact opaque reference and update edits the same message", async () => {
  const gateway = fakeGateway({ messageId: "message-9" })
  const port = new DiscordApprovalNotificationPort(gateway.gateway, { channelId: "approval-channel" })
  const reference = await port.post({
    approval: approvalView(),
    origin: { surface: "discord", externalLocation: "origin-channel" },
  })
  expect(port.adapter).toBe("discord")
  expect(reference).toBe(JSON.stringify({ chatId: "approval-channel", messageId: "message-9" }))

  await port.update(reference!, approvalView({ state: "denied" }))
  expect(gateway.sent[0]!.chatId).toBe("approval-channel")
  expect(gateway.sent[0]!.card.buttons).toHaveLength(2)
  expect(gateway.edited[0]).toMatchObject({ chatId: "approval-channel", messageId: "message-9" })
  expect(gateway.edited[0]!.card.buttons).toEqual([])
})

test("trusted Discord origin channel is the only fallback destination", async () => {
  const discord = fakeGateway({ messageId: "message-1" })
  const port = new DiscordApprovalNotificationPort(discord.gateway, {})
  expect(await port.post({
    approval: approvalView(),
    origin: { surface: "discord", externalLocation: "origin-channel" },
  })).toBe(JSON.stringify({ chatId: "origin-channel", messageId: "message-1" }))
  expect(discord.sent[0]!.chatId).toBe("origin-channel")

  const web = fakeGateway({ messageId: "should-not-post" })
  const webPort = new DiscordApprovalNotificationPort(web.gateway, {})
  expect(await webPort.post({
    approval: approvalView(),
    origin: { surface: "web", externalLocation: "untrusted-channel" },
  })).toBeNull()
  expect(web.sent).toEqual([])

  expect(await webPort.post({ approval: approvalView(), origin: null })).toBeNull()
})

test("post returns null when Discord does not return a message ID", async () => {
  const gateway = fakeGateway()
  const port = new DiscordApprovalNotificationPort(gateway.gateway, { channelId: "approval-channel" })
  expect(await port.post({ approval: approvalView(), origin: null })).toBeNull()
  expect(gateway.sent).toHaveLength(1)
})

test("invalid stored references are rejected strictly", async () => {
  const gateway = fakeGateway({ messageId: "message-1" })
  const port = new DiscordApprovalNotificationPort(gateway.gateway, {})
  const invalid = [
    "not-json",
    "null",
    "[]",
    JSON.stringify({ chatId: "channel" }),
    JSON.stringify({ chatId: "channel", messageId: "" }),
    JSON.stringify({ chatId: "channel", messageId: "message", extra: true }),
  ]
  for (const reference of invalid) {
    await expect(port.update(reference, approvalView())).rejects.toThrow("invalid_notification_reference")
  }
  expect(gateway.edited).toEqual([])
})

test("strict edit failures propagate to the notification service boundary", async () => {
  const gateway = fakeGateway({ editError: new Error("Discord edit rejected") })
  const port = new DiscordApprovalNotificationPort(gateway.gateway, {})
  const reference = JSON.stringify({ chatId: "approval-channel", messageId: "message-1" })
  await expect(port.update(reference, approvalView({ state: "expired" }))).rejects.toThrow("Discord edit rejected")
})
