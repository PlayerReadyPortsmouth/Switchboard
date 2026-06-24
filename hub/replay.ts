import type { AuditEvent } from "./types"

export interface ReplayRow {
  ts: number
  kind: string
  actor: string
  action: string
  target?: string
  outcome: string
  corr?: string
  groupHead: boolean    // first row of a corr group
}

export interface ReplayTimeline {
  id: string
  count: number
  spanMs: number
  costUsd: number
  rows: ReplayRow[]     // ordered by ts, corr threads kept contiguous
}

// A ledger row read via the unvalidated JSONL tail could (if hand-edited or
// truncated) lack ts/outcome — coerce so the timeline never renders NaN/undefined.
const tsOf = (e: AuditEvent): number => (typeof e.ts === "number" && Number.isFinite(e.ts) ? e.ts : 0)

/** Reconstruct the effect-chain for `id` — selecting every event whose `chat` OR
 *  `corr` equals `id`, ordering by time with each `corr` thread kept contiguous
 *  (sorted at the thread's earliest event). Pure. */
export function buildReplay(events: AuditEvent[], id: string): ReplayTimeline {
  const sel = events.filter((e) => e.chat === id || e.corr === id)
  // Earliest ts per corr → the thread's sort position.
  const groupTime = new Map<string, number>()
  for (const e of sel) {
    if (!e.corr) continue
    const t = groupTime.get(e.corr)
    const et = tsOf(e)
    if (t === undefined || et < t) groupTime.set(e.corr, et)
  }
  const ordered = sel
    .map((e) => ({ e, gt: e.corr ? groupTime.get(e.corr)! : tsOf(e) }))
    .sort((a, b) => a.gt - b.gt || tsOf(a.e) - tsOf(b.e))
  const seen = new Set<string>()
  const rows: ReplayRow[] = ordered.map(({ e }) => {
    const groupHead = !!e.corr && !seen.has(e.corr)
    if (e.corr) seen.add(e.corr)
    return { ts: tsOf(e), kind: e.kind, actor: e.actor, action: e.action, target: e.target, outcome: e.outcome ?? "?", corr: e.corr, groupHead }
  })
  const span = sel.length ? Math.max(...sel.map(tsOf)) - Math.min(...sel.map(tsOf)) : 0
  const costUsd = sel.reduce((s, e) => s + (e.cost ?? 0), 0)
  return { id, count: sel.length, spanMs: span, costUsd, rows }
}

/** Split a rendered message into chunks no longer than `maxLen`, breaking on
 *  newline boundaries (hard-splitting any single over-long line) so a long replay
 *  stays under Discord's 2000-char limit instead of being rejected whole. Pure. */
export function chunkLines(text: string, maxLen: number): string[] {
  const out: string[] = []
  let buf = ""
  for (const line of text.split("\n")) {
    if (buf && buf.length + 1 + line.length > maxLen) { out.push(buf); buf = "" }
    buf = buf ? `${buf}\n${line}` : line
    while (buf.length > maxLen) { out.push(buf.slice(0, maxLen)); buf = buf.slice(maxLen) }
  }
  if (buf) out.push(buf)
  return out
}

function humanizeMs(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60), rs = s % 60
  if (m < 60) return rs ? `${m}m${rs}s` : `${m}m`
  const h = Math.floor(m / 60), rm = m % 60
  return rm ? `${h}h${rm}m` : `${h}h`
}

/** Render a timeline to a chat string: a summary header, then one line per event
 *  (corr-grouped rows indented, the thread head tagged with its corr). Pure. */
export function renderReplay(t: ReplayTimeline, fmtTime: (ts: number) => string): string {
  if (t.count === 0) return `🧵 replay \`${t.id}\`: nothing recorded (pass a chat or corr id; audit must be enabled).`
  const header = `🧵 replay \`${t.id}\` — ${t.count} event${t.count === 1 ? "" : "s"} · ${humanizeMs(t.spanMs)} · $${t.costUsd.toFixed(4)}`
  const lines = t.rows.map((r) => {
    const indent = r.corr ? "    " : "  "
    const tgt = r.target ? ` → ${r.target}` : ""
    const tag = r.corr && r.groupHead ? `  (corr ${r.corr})` : ""
    const action = r.action && r.action !== r.kind ? ` ${r.action}` : ""
    return `\`${fmtTime(r.ts)}\`${indent}**${r.kind}**${action}  ${r.actor}${tgt}  [${r.outcome}]${tag}`
  })
  return [header, ...lines].join("\n")
}
