import { test, expect } from "bun:test"
import { DASHBOARD_HTML, renderDashboardJson } from "./web"
import type { PendingApproval } from "./approval"

test("the dashboard polls a RELATIVE api/status (works under a subpath mount)", () => {
  expect(DASHBOARD_HTML).toContain("fetch('api/status')")
  expect(DASHBOARD_HTML).not.toContain("fetch('/api/status')")
})

test("renderDashboardJson projects pendingApprovalList via webActions", () => {
  const e: PendingApproval = {
    id: "appr-1", kind: "outbound", target: "route-a", actor: "hub",
    summary: "POST → route-a", createdAt: 100, expiresAt: 200, state: "pending", fire: () => {},
  }
  const json = renderDashboardJson({
    now: 1000, startedAt: 0,
    status: { now: 1000, agents: [], overseers: [], routes: [], routeRate10m: 0, ephemerals: [] },
    audit: { total: 0, byKind: {}, byOutcome: {}, costUsd: 0, actors: 0 },
    recent: [], pendingApprovals: 1, pendingApprovalList: [e],
  })
  expect(json.pendingApprovalList).toEqual([{
    id: "appr-1", kind: "outbound", target: "route-a", actor: "hub", chat: undefined,
    summary: "POST → route-a", createdAt: 100, expiresAt: 200,
  }])
})

test("the dashboard HTML has an approvals panel and a channel chat pane", () => {
  expect(DASHBOARD_HTML).toContain('id="approvals"')
  expect(DASHBOARD_HTML).toContain('id="chat"')
  expect(DASHBOARD_HTML).toContain("api/channels")
})

test("the [data-cmd] click handler renders the command result into the chat pane via chatLine", () => {
  expect(DASHBOARD_HTML).toContain("fetch('api/command/'+cmd")
  expect(DASHBOARD_HTML).toContain("chatLine({ts: Date.now(), origin: 'agent', author: cmd, content: d.text})")
})

test("the dashboard HTML has a Doctor command button and a Chat/Timeline mode toggle", () => {
  expect(DASHBOARD_HTML).toContain('data-cmd="doctor"')
  expect(DASHBOARD_HTML).toContain('data-mode="chat"')
  expect(DASHBOARD_HTML).toContain('data-mode="timeline"')
  expect(DASHBOARD_HTML).toContain("api/channel/'+")
  expect(DASHBOARD_HTML).toContain("/timeline")
})

test("the Timeline view shows an explicit empty state instead of a silent blank pane", () => {
  expect(DASHBOARD_HTML).toContain('no trace records')
})

test("the dashboard HTML has agent-config edit affordances and a JSON editor panel", () => {
  expect(DASHBOARD_HTML).toContain('id="newAgentBtn"')
  expect(DASHBOARD_HTML).toContain('id="agentEditor"')
  expect(DASHBOARD_HTML).toContain('id="agentEditorText"')
  expect(DASHBOARD_HTML).toContain("api/agents")
  expect(DASHBOARD_HTML).toContain("/preview")
  expect(DASHBOARD_HTML).toContain("/confirm")
})

test("openAgentEditor resets the textarea display to 'block' so it stays visible after Remove flow", () => {
  expect(DASHBOARD_HTML).toContain("$('agentEditorText').style.display = 'block'")
})
