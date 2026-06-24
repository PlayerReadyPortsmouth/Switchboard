import type { StatusSnapshot } from "./statusRegistry"
import type { AuditEvent, AuditSummary } from "./types"
import { renderHealth } from "./metrics"

export interface WebInput {
  now: number
  startedAt: number
  status: StatusSnapshot
  audit: AuditSummary
  recent: AuditEvent[]       // recent ledger rows for the activity feed
  pendingApprovals: number
}

export interface DashboardJson {
  status: "ok" | "degraded"
  uptimeSec: number
  routeRate10m: number
  pendingApprovals: number
  agents: { name: string; alive: boolean; busy: boolean; contextFill: number; queueDepth: number; costUsd: number; replicas: number }[]
  ephemerals: { jobId: string; agent: string; task: string }[]
  audit: AuditSummary
  recent: { ts: number; kind: string; actor: string; action: string; target?: string; outcome: string }[]
}

/** Project the snapshot + audit into the dashboard payload. Reuses renderHealth's
 *  readiness rule so the web view and /health never disagree. Metadata only —
 *  exactly what !status/!audit expose (no message content, no secrets). Pure. */
export function renderDashboardJson(i: WebInput): DashboardJson {
  const { body } = renderHealth({ now: i.now, startedAt: i.startedAt, status: i.status, audit: i.audit, pendingApprovals: i.pendingApprovals })
  return {
    status: body.status,
    uptimeSec: body.uptimeSec,
    routeRate10m: i.status.routeRate10m,
    pendingApprovals: i.pendingApprovals,
    agents: i.status.agents.map((a) => ({
      name: a.name, alive: a.alive, busy: a.busy, contextFill: a.fillPct,
      queueDepth: a.queueDepth, costUsd: a.costUsd ?? 0, replicas: a.replicas ?? 1,
    })),
    // `task` is agent-output-derived free text — truncate so the payload stays bounded metadata.
    ephemerals: i.status.ephemerals.map((e) => ({ jobId: e.jobId, agent: e.agent, task: e.task.slice(0, 120) })),
    audit: i.audit,
    recent: i.recent.map((e) => ({ ts: e.ts, kind: e.kind, actor: e.actor, action: e.action, target: e.target, outcome: e.outcome })),
  }
}

/** The dashboard page: self-contained (inline CSS + a poll-and-render script over
 *  /api/status), no build step, no external assets. */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Switchboard</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; font:14px/1.5 system-ui,-apple-system,sans-serif; background:#0f1115; color:#e6e6e6; }
  header { padding:16px 20px; border-bottom:1px solid #232733; display:flex; gap:20px; align-items:center; flex-wrap:wrap; }
  h1 { font-size:16px; margin:0; font-weight:600; }
  .badge { padding:2px 8px; border-radius:10px; font-weight:600; font-size:12px; text-transform:uppercase; }
  .ok { background:#143d2b; color:#3ad07f; } .degraded { background:#4a1f1f; color:#ff6b6b; }
  .muted { color:#8b93a7; }
  main { padding:20px; display:grid; gap:24px; max-width:1000px; }
  table { width:100%; border-collapse:collapse; }
  th,td { text-align:left; padding:6px 10px; border-bottom:1px solid #1d2129; }
  th { color:#8b93a7; font-weight:500; font-size:12px; }
  .bar { height:8px; background:#1d2129; border-radius:4px; overflow:hidden; width:120px; display:inline-block; vertical-align:middle; }
  .bar > i { display:block; height:100%; background:#4f8cff; }
  .feed div { padding:4px 0; border-bottom:1px solid #1a1d24; font-family:ui-monospace,monospace; font-size:12px; }
  .dot { display:inline-block; width:8px; height:8px; border-radius:50%; }
  .alive { background:#3ad07f; } .dead { background:#5a5f6b; }
  section h2 { font-size:13px; text-transform:uppercase; letter-spacing:.05em; color:#8b93a7; margin:0 0 8px; }
</style>
</head>
<body>
<header>
  <h1>&#9889; Switchboard</h1>
  <span id="status" class="badge">&hellip;</span>
  <span class="muted">up <b id="uptime">&ndash;</b></span>
  <span class="muted">routes/10m <b id="routes">&ndash;</b></span>
  <span class="muted">pending approvals <b id="pending">&ndash;</b></span>
  <span class="muted">ephemerals <b id="ephem">&ndash;</b></span>
  <span class="muted" id="updated" style="margin-left:auto"></span>
</header>
<main>
  <section><h2>Agents</h2><table><thead><tr><th></th><th>agent</th><th>state</th><th>context</th><th>queue</th><th>cost</th><th>replicas</th></tr></thead><tbody id="agents"></tbody></table></section>
  <section><h2>Ledger</h2><div id="summary" class="muted"></div></section>
  <section><h2>Recent activity</h2><div id="feed" class="feed"></div></section>
</main>
<script>
var $ = function(id){ return document.getElementById(id); };
function esc(s){ return String(s).replace(/[&<>]/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;'})[c]; }); }
function fmtTime(ts){ return new Date(ts).toISOString().slice(11,19); }
function fmtDur(s){ var m=Math.floor(s/60), h=Math.floor(m/60); return h>0 ? h+'h'+(m%60)+'m' : m+'m'; }
function render(d){
  var st=$('status'); st.textContent=d.status; st.className='badge '+d.status;
  $('uptime').textContent=fmtDur(d.uptimeSec);
  $('routes').textContent=d.routeRate10m;
  $('pending').textContent=d.pendingApprovals;
  $('ephem').textContent=d.ephemerals.length;
  $('agents').innerHTML=d.agents.map(function(a){
    var pct=Math.round(a.contextFill*100);
    return '<tr><td><span class="dot '+(a.alive?'alive':'dead')+'"></span></td>'+
      '<td>'+esc(a.name)+'</td><td class="muted">'+(a.busy?'busy':'idle')+'</td>'+
      '<td><div class="bar"><i style="width:'+pct+'%"></i></div> '+pct+'%</td>'+
      '<td>'+a.queueDepth+'</td><td>$'+a.costUsd.toFixed(4)+'</td><td>'+a.replicas+'</td></tr>';
  }).join('') || '<tr><td colspan="7" class="muted">no agents</td></tr>';
  var s=d.audit;
  $('summary').textContent='events '+s.total+'  cost $'+s.costUsd.toFixed(4)+'  actors '+s.actors+'  '+
    Object.keys(s.byKind).map(function(k){ return k+':'+s.byKind[k]; }).join('  ');
  $('feed').innerHTML=d.recent.slice().reverse().map(function(e){
    return '<div>'+fmtTime(e.ts)+'  '+esc(e.kind)+'  '+esc(e.actor)+'  '+esc(e.action)+
      (e.target?'  '+esc(e.target):'')+(e.outcome!=='ok'?'  ['+esc(e.outcome)+']':'')+'</div>';
  }).join('') || '<div class="muted">no events</div>';
  $('updated').textContent='updated '+fmtTime(Date.now());
}
function poll(){ fetch('/api/status').then(function(r){ return r.json(); }).then(render).catch(function(){}); }
poll(); setInterval(poll, 3000);
</script>
</body>
</html>`
