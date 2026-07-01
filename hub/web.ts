import type { StatusSnapshot } from "./statusRegistry"
import type { AuditEvent, AuditSummary } from "./types"
import type { PendingApproval } from "./approval"
import { renderHealth } from "./metrics"
import { pendingApprovalsToJson, type PendingApprovalJson } from "./webActions"

export interface WebInput {
  now: number
  startedAt: number
  status: StatusSnapshot
  audit: AuditSummary
  recent: AuditEvent[]       // recent ledger rows for the activity feed
  pendingApprovals: number
  pendingApprovalList: PendingApproval[]   // NEW
}

export interface DashboardJson {
  status: "ok" | "degraded"
  uptimeSec: number
  routeRate10m: number
  pendingApprovals: number
  pendingApprovalList: PendingApprovalJson[]   // NEW
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
    pendingApprovalList: pendingApprovalsToJson(i.pendingApprovalList),
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
  <section><h2>Approvals</h2><div id="approvals" class="muted">no pending approvals</div></section>
  <section>
    <h2>Channel chat</h2>
    <select id="channelPicker"><option value="">select a channel…</option></select>
    <div id="cmdRow" style="margin:8px 0"></div>
    <div id="chat" class="feed" style="max-height:320px;overflow-y:auto"></div>
    <form id="chatForm" style="margin-top:8px;display:flex;gap:8px">
      <input id="chatInput" type="text" placeholder="Message this channel…" style="flex:1;background:#1a1d24;border:1px solid #232733;color:#e6e6e6;padding:6px 8px;border-radius:4px">
      <button type="submit">Send</button>
    </form>
  </section>
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
  renderApprovals(d.pendingApprovalList);
  $('updated').textContent='updated '+fmtTime(Date.now());
}
function poll(){ fetch('api/status').then(function(r){ return r.json(); }).then(render).catch(function(){}); }
poll(); setInterval(poll, 3000);

function renderApprovals(list){
  $('approvals').innerHTML = list.length ? list.map(function(a){
    return '<div style="margin-bottom:8px">'+esc(a.summary)+' <span class="muted">('+esc(a.kind)+' · '+esc(a.target)+' · by '+esc(a.actor)+')</span> '+
      '<button data-appr="'+a.id+'" data-decision="grant">Approve</button> '+
      '<button data-appr="'+a.id+'" data-decision="deny">Deny</button></div>';
  }).join('') : 'no pending approvals';
}
document.addEventListener('click', function(ev){
  var btn = ev.target.closest('[data-appr]');
  if (!btn) return;
  fetch('api/approvals/'+btn.getAttribute('data-appr'), {
    method: 'POST', headers: {'content-type':'application/json'},
    body: JSON.stringify({decision: btn.getAttribute('data-decision')}),
  }).then(poll);
});

var currentChannel = null, es = null;
function chatLine(e){
  var div = document.createElement('div');
  div.textContent = fmtTime(e.ts)+' ['+e.origin+'] '+e.author+': '+e.content;
  return div;
}
function openChannel(id){
  if (es) { es.close(); es = null; }
  currentChannel = id;
  $('chat').innerHTML = '';
  if (!id) return;
  fetch('api/channel/'+id+'/history').then(function(r){ return r.json(); }).then(function(rows){
    rows.forEach(function(e){ $('chat').appendChild(chatLine(e)); });
    $('chat').scrollTop = $('chat').scrollHeight;
  });
  es = new EventSource('api/channel/'+id+'/stream');
  es.onmessage = function(ev){
    $('chat').appendChild(chatLine(JSON.parse(ev.data)));
    $('chat').scrollTop = $('chat').scrollHeight;
  };
  $('cmdRow').innerHTML = '<button data-cmd="audit">Audit</button> <button data-cmd="tools">Tools</button>';
}
$('channelPicker').addEventListener('change', function(){ openChannel(this.value || null); });
document.addEventListener('click', function(ev){
  var btn = ev.target.closest('[data-cmd]');
  if (!btn || !currentChannel) return;
  fetch('api/command/'+btn.getAttribute('data-cmd'), {
    method: 'POST', headers: {'content-type':'application/json'},
    body: JSON.stringify({channelId: currentChannel}),
  });
});
$('chatForm').addEventListener('submit', function(ev){
  ev.preventDefault();
  if (!currentChannel) return;
  var text = $('chatInput').value.trim();
  if (!text) return;
  $('chatInput').value = '';
  fetch('api/channel/'+currentChannel+'/message', {
    method: 'POST', headers: {'content-type':'application/json'},
    body: JSON.stringify({text: text}),
  });
});
function loadChannels(){
  fetch('api/channels').then(function(r){ return r.json(); }).then(function(rows){
    var sel = $('channelPicker');
    var have = {}; for (var i=1;i<sel.options.length;i++) have[sel.options[i].value]=true;
    rows.forEach(function(c){
      if (have[c.channelId]) return;
      var opt = document.createElement('option');
      opt.value = c.channelId; opt.textContent = (c.name || c.channelId) + ' ('+c.agent+')';
      sel.appendChild(opt);
    });
  });
}
loadChannels(); setInterval(loadChannels, 15000);
</script>
</body>
</html>`
