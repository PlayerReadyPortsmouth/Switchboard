import type { MouseEvent, Ref } from "react"
import { pathForApproval } from "../routes"
import type { ApprovalPendingAggregate } from "../types"

export interface ApprovalContextNavigation {
  approvalId: string | null
  conversationId: string
  focus: "approval-detail" | "approval-queue"
}

export interface ApprovalContextBannerProps {
  aggregate: ApprovalPendingAggregate | null
  conversationId: string
  now?: number
  linkRef?: Ref<HTMLAnchorElement>
  onNavigate?(target: ApprovalContextNavigation, trigger: HTMLAnchorElement): void
}

const titleCase = (value: string): string => value.replace(/^./, first => first.toUpperCase())

function expiryCopy(expiresAt: number, now: number): string {
  const minutes = Math.max(1, Math.ceil((expiresAt - now) / 60_000))
  return `in ${minutes} ${minutes === 1 ? "minute" : "minutes"}`
}

export function ApprovalContextBanner({ aggregate, conversationId, now = Date.now(), linkRef, onNavigate }: ApprovalContextBannerProps) {
  if (!aggregate
    || !Number.isSafeInteger(aggregate.count)
    || aggregate.count <= 0
    || aggregate.highestRisk === null
    || aggregate.nearestExpiry === null
    || !Number.isFinite(aggregate.nearestExpiry)
    || (aggregate.count === 1 && !aggregate.firstId)) return null

  const multiple = aggregate.count > 1
  const expiry = expiryCopy(aggregate.nearestExpiry, now)
  const href = multiple
    ? pathForApproval(null, { group: "pending", conversationId })
    : pathForApproval(aggregate.firstId!)
  const navigation: ApprovalContextNavigation = {
    approvalId: multiple ? null : aggregate.firstId,
    conversationId,
    focus: multiple ? "approval-queue" : "approval-detail",
  }
  const countCopy = `${aggregate.count} ${aggregate.count === 1 ? "approval" : "approvals"} pending`
  const navigate = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!onNavigate) return
    event.preventDefault()
    onNavigate(navigation, event.currentTarget)
  }

  return <aside className="approval-context-banner" aria-label="Pending approval context" data-risk={aggregate.highestRisk}>
    <span className="approval-context-icon" data-approval-context-icon aria-hidden="true">◇</span>
    <div className="approval-context-copy">
      <strong>{countCopy}</strong>
      <span><b>{titleCase(aggregate.highestRisk)} risk</b><span>Pending</span></span>
      <small>Nearest expiry <time dateTime={new Date(aggregate.nearestExpiry).toISOString()}>{expiry}</time></small>
    </div>
    <a ref={linkRef} href={href} onClick={navigate}>{multiple ? `Review ${aggregate.count} pending approvals` : "Review approval"}</a>
    <span className="sr-only" aria-live="polite" aria-atomic="true" data-approval-context-announcer>
      {countCopy}. {titleCase(aggregate.highestRisk)} risk; nearest expiry {expiry}.
    </span>
  </aside>
}
