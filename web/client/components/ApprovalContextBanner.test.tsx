import "../testSetup"
import { afterEach, describe, expect, test } from "bun:test"
import { cleanup, render, within } from "@testing-library/react"
import type { ApprovalPendingAggregate } from "../types"
import { ApprovalContextBanner } from "./ApprovalContextBanner"

const screen = within(document.body)
const NOW = 1_700_000_000_000

const aggregate = (overrides: Partial<ApprovalPendingAggregate> = {}): ApprovalPendingAggregate => ({
  count: 1,
  highestRisk: "elevated",
  nearestExpiry: NOW + 300_000,
  firstId: "approval/direct",
  ...overrides,
})

afterEach(cleanup)

describe("approval conversation context", () => {
  test("one exact aggregate shows risk, state, nearest expiry, and the canonical detail link", () => {
    render(<ApprovalContextBanner aggregate={aggregate()} conversationId="conversation/1" now={NOW} />)

    const banner = screen.getByRole("complementary", { name: "Pending approval context" })
    expect(within(banner).getByText("1 approval pending")).toBeTruthy()
    expect(within(banner).getByText("Elevated risk")).toBeTruthy()
    expect(within(banner).getByText("Pending")).toBeTruthy()
    const expiry = within(banner).getByText("in 5 minutes").closest("time")!
    expect(expiry.getAttribute("datetime")).toBe(new Date(NOW + 300_000).toISOString())
    const link = within(banner).getByRole("link", { name: "Review approval" }) as HTMLAnchorElement
    expect(new URL(link.href).pathname).toBe("/approvals/approval%2Fdirect")
  })

  test("multiple requests link to the pending queue filtered by conversation", () => {
    render(<ApprovalContextBanner aggregate={aggregate({ count: 3 })} conversationId="conversation/1" now={NOW} />)

    const link = screen.getByRole("link", { name: "Review 3 pending approvals" }) as HTMLAnchorElement
    const target = new URL(link.href)
    expect(`${target.pathname}${target.search}`).toBe("/approvals?group=pending&conversationId=conversation%2F1")
  })

  test("uses the server aggregate for a page-spanning mixed-risk queue", () => {
    const nearestExpiry = NOW + 60_000
    render(<ApprovalContextBanner aggregate={aggregate({
      count: 137,
      highestRisk: "destructive",
      nearestExpiry,
      firstId: "first-page-low-risk",
    })} conversationId="large-conversation" now={NOW} />)

    const banner = screen.getByRole("complementary", { name: "Pending approval context" })
    expect(within(banner).getByText("137 approvals pending")).toBeTruthy()
    expect(within(banner).getByText("Destructive risk")).toBeTruthy()
    expect(within(banner).getByText("in 1 minute").closest("time")?.getAttribute("datetime")).toBe(new Date(nearestExpiry).toISOString())
    expect(within(banner).getByRole("link", { name: "Review 137 pending approvals" })).toBeTruthy()
    expect(banner.getAttribute("data-risk")).toBe("destructive")
    expect(within(banner).getByText("Pending")).toBeTruthy()
    expect(banner.querySelector("[data-approval-context-icon]")?.getAttribute("aria-hidden")).toBe("true")
  })

  test("empty and unavailable aggregates render no banner", () => {
    const view = render(<ApprovalContextBanner aggregate={null} conversationId="conversation/1" now={NOW} />)
    expect(screen.queryByRole("complementary", { name: "Pending approval context" })).toBeNull()

    view.rerender(<ApprovalContextBanner aggregate={aggregate({ count: 0, highestRisk: null, nearestExpiry: null, firstId: null })} conversationId="conversation/1" now={NOW} />)
    expect(screen.queryByRole("complementary", { name: "Pending approval context" })).toBeNull()
  })

  test("count and expiry updates use a polite live region without stealing focus", () => {
    const focusTarget = document.createElement("button")
    document.body.append(focusTarget)
    focusTarget.focus()
    const view = render(<ApprovalContextBanner aggregate={aggregate({ count: 2 })} conversationId="conversation/1" now={NOW} />)

    view.rerender(<ApprovalContextBanner aggregate={aggregate({
      count: 4,
      highestRisk: "destructive",
      nearestExpiry: NOW + 120_000,
    })} conversationId="conversation/1" now={NOW} />)

    const announcer = document.querySelector("[data-approval-context-announcer]")!
    expect(announcer.getAttribute("aria-live")).toBe("polite")
    expect(announcer.getAttribute("aria-atomic")).toBe("true")
    expect(announcer.textContent).toContain("4 approvals pending")
    expect(announcer.textContent).toContain("nearest expiry in 2 minutes")
    expect(document.activeElement).toBe(focusTarget)

    view.rerender(<ApprovalContextBanner aggregate={aggregate({
      count: 4,
      highestRisk: "destructive",
      nearestExpiry: NOW + 120_000,
    })} conversationId="conversation/1" now={NOW} />)
    expect(document.activeElement).toBe(focusTarget)
    focusTarget.remove()
  })
})
