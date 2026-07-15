import { test, expect } from "bun:test"
import { Window } from "happy-dom"
import { DASHBOARD_HTML, renderDashboardJson } from "./web"

test("the dashboard polls a RELATIVE api/status (works under a subpath mount)", () => {
  expect(DASHBOARD_HTML).toContain("fetch('api/status')")
  expect(DASHBOARD_HTML).not.toContain("fetch('/api/status')")
})

test("the dashboard's <script> block is syntactically valid JS", () => {
  // DASHBOARD_HTML is itself a backtick template literal, so a literal \n
  // typed inside it — even inside what's meant to be a nested single-quoted
  // JS string for the browser — gets consumed by the OUTER TypeScript
  // template literal and turned into a real newline character before the
  // browser ever sees it, landing a raw newline inside a single-quoted
  // string literal (a syntax error). Because a syntax error anywhere in a
  // <script> block prevents ANY of that block's code from running — not
  // just the offending line — this one check stands in for the whole
  // dashboard's basic functionality. The other tests in this file only
  // assert DASHBOARD_HTML.toContain(...) on string markers, which cannot
  // catch this class of bug (it's a real string, just an invalid one).
  const m = DASHBOARD_HTML.match(/<script>([\s\S]*)<\/script>/)
  expect(m).not.toBeNull()
  expect(() => new Function(m![1]!)).not.toThrow()
})

test("renderDashboardJson keeps only the aggregate approval count", () => {
  const json = renderDashboardJson({
    now: 1000, startedAt: 0,
    status: { now: 1000, agents: [], overseers: [], routes: [], routeRate10m: 0, ephemerals: [] },
    audit: { total: 0, byKind: {}, byOutcome: {}, costUsd: 0, actors: 0 },
    recent: [], pendingApprovals: 1,
  })
  expect(json.pendingApprovals).toBe(1)
  expect(json).not.toHaveProperty("pendingApprovalList")
})

test("legacy approvals load separately and send version-bound idempotent decisions", () => {
  expect(DASHBOARD_HTML).toContain("fetch('api/approvals')")
  expect(DASHBOARD_HTML).not.toContain("fetch('/api/approvals')")
  expect(DASHBOARD_HTML).not.toContain("pendingApprovalList")
  expect(DASHBOARD_HTML).toContain("data-version")
  expect(DASHBOARD_HTML).toContain("expectedVersion")
  expect(DASHBOARD_HTML).toContain("'Idempotency-Key': key")
  expect(DASHBOARD_HTML.split("crypto.randomUUID()").length - 1).toBe(1)
  expect(DASHBOARD_HTML).toContain("decideApproval(retryButton, key, true)")
  expect(DASHBOARD_HTML).toContain("response.status === 409")
  expect(DASHBOARD_HTML).toContain("if (!response.ok) return reloadCanonicalApprovals();")
  expect(DASHBOARD_HTML).not.toContain("if (!response.ok) return recoverAmbiguousApproval")
})

test("legacy approval rendering treats hostile canonical strings as text", () => {
  const script = DASHBOARD_HTML.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? ""
  const start = script.indexOf("function renderApprovals(")
  const end = script.indexOf("function findApprovalButton(", start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)

  const window = new Window()
  window.document.body.innerHTML = '<div id="approvals"></div>'
  const renderApprovals = new Function(
    "document",
    `var $ = function(id){ return document.getElementById(id); };${script.slice(start, end)};return renderApprovals;`,
  )(window.document) as (items: unknown[]) => void
  const hostile = "<img src=x onerror=alert(1)>"
  renderApprovals([{
    id: "approval-1", version: "opaque-version", summary: hostile, kind: hostile,
    target: hostile, requestedBy: { surface: "agent", id: hostile },
  }])

  const approvals = window.document.getElementById("approvals")!
  expect(approvals.textContent).toContain(hostile)
  expect(approvals.querySelector("img")).toBeNull()
  expect(approvals.querySelector("button")?.getAttribute("data-version")).toBe("opaque-version")
})

test("a stale pre-decision poll cannot reopen approvals after canonical recovery fails", async () => {
  type Deferred<T> = {
    promise: Promise<T>
    resolve(value: T): void
    reject(error: unknown): void
  }
  const deferred = <T>(): Deferred<T> => {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
    return { promise, resolve, reject }
  }
  const page = (version: string) => ({ items: [{
    id: "approval-1", version, summary: "Deploy", kind: "outbound", target: "route-a",
    state: "pending", requestedBy: { surface: "agent", id: "qa" },
  }] })
  const response = (body: unknown) => new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  })
  const approvalReads: Deferred<Response>[] = []
  const decisions: Deferred<Response>[] = []
  const fetchMock = ((input: RequestInfo | URL) => {
    const url = String(input)
    if (url === "api/status") return Promise.resolve(response({}))
    const request = deferred<Response>()
    if (url === "api/approvals") approvalReads.push(request)
    else if (url.startsWith("api/approvals/")) decisions.push(request)
    else throw new Error(`unexpected fetch: ${url}`)
    return request.promise
  }) as typeof fetch

  const script = DASHBOARD_HTML.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? ""
  const start = script.indexOf("var approvalDecisionPending")
  const end = script.indexOf("var currentChannel", start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  const approvalScript = script.slice(start, end).replace("poll(); setInterval(poll, 3000);", "")
  const window = new Window()
  window.document.body.innerHTML = '<div id="approvals"></div>'
  const harness = new Function(
    "document", "fetch", "crypto", "setInterval",
    `var $ = function(id){ return document.getElementById(id); };
     function render(){}
     ${approvalScript}
     return {
       poll: poll,
       renderApprovals: renderApprovals,
       decideApproval: decideApproval,
       state: function(){ return { decisionPending: approvalDecisionPending, reloadRequired: approvalReloadRequired }; }
     };`,
  )(
    window.document,
    fetchMock,
    { randomUUID: () => "unused-click-key" },
    () => 0,
  ) as {
    poll(): void
    renderApprovals(items: unknown[]): void
    decideApproval(button: unknown, key: string, retried: boolean): Promise<void>
    state(): { decisionPending: boolean; reloadRequired: boolean }
  }
  const flush = () => new Promise(resolve => setTimeout(resolve, 0))

  harness.renderApprovals(page("2").items)
  harness.poll()
  const decision = harness.decideApproval(
    window.document.querySelector('[data-appr="approval-1"][data-decision="grant"]')!,
    "attempt-1",
    false,
  )
  decisions[0]!.reject(new Error("network ambiguity"))
  await flush()
  expect(approvalReads).toHaveLength(2)
  approvalReads[1]!.reject(new Error("canonical reload unavailable"))
  await decision
  expect(harness.state()).toEqual({ decisionPending: false, reloadRequired: true })
  expect((window.document.querySelector("[data-appr]") as unknown as { disabled: boolean }).disabled).toBe(true)

  approvalReads[0]!.resolve(response(page("1")))
  await flush()
  expect(harness.state()).toEqual({ decisionPending: false, reloadRequired: true })
  expect(window.document.querySelector("[data-appr]")?.getAttribute("data-version")).toBe("2")
  expect((window.document.querySelector("[data-appr]") as unknown as { disabled: boolean }).disabled).toBe(true)

  harness.poll()
  approvalReads[2]!.resolve(response(page("3")))
  await flush()
  expect(harness.state()).toEqual({ decisionPending: false, reloadRequired: false })
  expect(window.document.querySelector("[data-appr]")?.getAttribute("data-version")).toBe("3")
  expect((window.document.querySelector("[data-appr]") as unknown as { disabled: boolean }).disabled).toBe(false)
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
  expect(DASHBOARD_HTML).toContain('id="agentEditorTree"')
  expect(DASHBOARD_HTML).toContain("api/agents")
  expect(DASHBOARD_HTML).toContain("/preview")
  expect(DASHBOARD_HTML).toContain("/confirm")
})

test("openAgentEditor resets the tree container to visible on every open, not just Cancel", () => {
  // Superseded by the JSON tree editor (Task 1): the textarea-visibility bug this
  // test used to guard against textarea now applies to #agentEditorTree instead.
  // openAgentEditor (Step 5) is now the SOLE chokepoint that sets display='block' —
  // Cancel (Step 9) no longer duplicates the reset — so the marker should appear
  // exactly once in the whole script, not twice.
  var marker = "agentEditorTree').style.display = 'block'";
  var occurrences = DASHBOARD_HTML.split(marker).length - 1;
  expect(occurrences).toBe(1);
})

test("New Agent shows a 'New agent' title instead of 'Edit agent'", () => {
  expect(DASHBOARD_HTML).toContain("openAgentEditor(name, template, true)")
  expect(DASHBOARD_HTML).toContain("isNew ? ('New agent: '+name) : ('Edit agent: '+name)")
})

test("the dashboard HTML has hub-config edit affordances and a JSON editor panel", () => {
  expect(DASHBOARD_HTML).toContain('id="editHubConfigBtn"')
  expect(DASHBOARD_HTML).toContain('id="hubConfigEditor"')
  expect(DASHBOARD_HTML).toContain('id="hubConfigEditorTree"')
  expect(DASHBOARD_HTML).toContain("api/hub-config")
})

test("the dashboard has a tree-editor container for agents, not the old raw-JSON textarea", () => {
  expect(DASHBOARD_HTML).toContain('id="agentEditorTree"')
  expect(DASHBOARD_HTML).not.toContain('id="agentEditorText"')
})

test("the dashboard defines the shared jsonTree renderer functions", () => {
  expect(DASHBOARD_HTML).toContain("function jsonTreeIsLongString(")
  expect(DASHBOARD_HTML).toContain("function jsonTreeRenderChildren(")
  expect(DASHBOARD_HTML).toContain("function jsonTreeRenderValue(")
  expect(DASHBOARD_HTML).toContain("function jsonTreeRenderContainer(")
  expect(DASHBOARD_HTML).toContain("function jsonTreeRenderLongString(")
  expect(DASHBOARD_HTML).toContain("function jsonTreeRenderRoot(")
})

test("openAgentEditor no longer JSON.stringifies a template into a textarea", () => {
  expect(DASHBOARD_HTML).not.toContain("JSON.stringify(all[name], null, 2)")
  expect(DASHBOARD_HTML).toContain("openAgentEditor(name, all[name], false)")
})

test("the dashboard has a tree-editor container for hub config, not the old raw-JSON textarea", () => {
  expect(DASHBOARD_HTML).toContain('id="hubConfigEditorTree"')
  expect(DASHBOARD_HTML).not.toContain('id="hubConfigEditorText"')
})

test("the hub config preview handler sends the live tree data, not a parsed textarea value", () => {
  expect(DASHBOARD_HTML).toContain("body: JSON.stringify({config: hubConfigTreeData})")
  expect(DASHBOARD_HTML).not.toContain("JSON.parse($('hubConfigEditorText').value)")
})
