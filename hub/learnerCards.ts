// The Learner's approve / reject cards.
//
// Each prompt change the Learner proposes is posted as its own card. Only a named
// approver can press Approve; approving ADDS the proposed wording to that agent's
// instructions (the old file is kept) and nothing else. Tool and allow-list
// proposals are shown for reading only: who may use which tool is a permissions
// decision and is never applied from a button.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type { CardSpec } from "./types"
import type { LearnerReport, Proposal } from "./learnerDiagnose"

export const LEARNER_PREFIX = "lrn:"
export type LearnerVerb = "approve" | "reject"
export function learnerCustomId(verb: LearnerVerb, id: string): string { return `${LEARNER_PREFIX}${verb}:${id}` }
export function parseLearnerCustomId(customId: string): { verb: LearnerVerb; id: string } | null {
  const m = /^lrn:(approve|reject):([a-z0-9]+)$/.exec(customId)
  return m ? { verb: m[1] as LearnerVerb, id: m[2]! } : null
}

type State = "open" | "approved" | "rejected" | "failed"
interface PendingEdit { id: string; proposal: Proposal; chatId: string; messageId: string; at: number; state: State; by?: string }

export interface LearnerCardsDeps {
  storePath: string                                   // survives a restart, so old cards still work
  sendCard: (chatId: string, card: CardSpec) => Promise<string | undefined>
  editCard: (chatId: string, messageId: string, card: CardSpec) => Promise<void>
  approversFor: (agent: string) => string[]
  /** Add `text` to this agent's instructions. Returns a reason string if it could not. */
  applyPromptEdit: (agent: string, text: string, by: string) => string | undefined
  audit?: (e: { action: string; agent: string; userId?: string; outcome: string; detail?: Record<string, unknown> }) => void
  now?: () => number
  genId?: () => string
}

const OTHER_HEAD: Record<string, string> = {
  allow_tool: "Tools to consider allowing", build_tool: "Tools that do not exist yet",
  readyapp_fix: "ReadyApp-side faults", no_change: "Looked at, no change needed",
}
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** The wording as it is stored, marked so a person can find and remove what was learned. */
export function learnedLine(text: string, at: number): string {
  return `LEARNED ${new Date(at).toISOString().slice(0, 10)}: ${text.replace(/\s+/g, " ").trim()}`
}

export class LearnerCards {
  private pending = new Map<string, PendingEdit>()
  private seq = 0
  constructor(private readonly d: LearnerCardsDeps) {
    try {
      if (existsSync(d.storePath)) {
        for (const p of JSON.parse(readFileSync(d.storePath, "utf8")) as PendingEdit[]) if (p?.id && p.proposal) this.pending.set(p.id, p)
      }
    } catch { /* an unreadable store just means old cards no longer work */ }
  }
  private now(): number { return this.d.now?.() ?? Date.now() }
  private save(): void {
    try {
      const dir = dirname(this.d.storePath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const keep = [...this.pending.values()].filter(p => p.state === "open" || this.now() - p.at < 14 * 24 * 3600_000)
      const tmp = `${this.d.storePath}.tmp`
      writeFileSync(tmp, JSON.stringify(keep, null, 2)); renameSync(tmp, this.d.storePath)
    } catch { /* best effort */ }
  }

  private summaryCard(r: LearnerReport, edits: number): CardSpec {
    const total = r.findings.reduce((n, f) => n + f.total, 0)
    const lines = [`${total} miss${total === 1 ? "" : "es"}: ${r.findings.map(f => `${f.agent} ${f.total}`).join(", ")}.`]
    lines.push(edits ? `${edits} prompt change${edits === 1 ? "" : "s"} below, each waiting for a yes or no. **Nothing has been applied.**` : "No prompt changes proposed.")
    for (const [type, head] of Object.entries(OTHER_HEAD)) {
      const ps = r.proposals.filter(p => p.type === type)
      if (!ps.length) continue
      lines.push("", `**${head}**`)
      for (const p of ps.slice(0, 6)) lines.push(`- ${p.agent}: ${p.summary}${p.tool ? ` (\`${p.tool}\`)` : ""}`)
    }
    if (r.failed.length) lines.push("", `The diagnosis did not run for: ${r.failed.join(", ")}.`)
    return { title: "🎓 Learner report", body: clip(lines.join("\n"), 3900), buttons: [], footer: "Tool and allow-list items are for reading: they are never applied from here." }
  }

  private editCard(p: PendingEdit): CardSpec {
    const pr = p.proposal
    const head: Record<State, string> = {
      open: `Proposed for **${pr.agent}**. Nothing has changed yet.`,
      approved: `✅ Approved by <@${p.by}>. Added to ${pr.agent}'s instructions; it applies from that agent's next fresh session.`,
      rejected: `Rejected by <@${p.by}>. Nothing was changed.`,
      failed: `❌ Not applied. Nothing was changed.`,
    }
    return {
      title: clip(`🎓 ${pr.agent}: ${pr.summary}`, 250),
      body: head[p.state],
      fields: [
        { name: "Wording to add", value: clip(pr.text ?? "", 1000), inline: false },
        ...(pr.why ? [{ name: `Why (${pr.evidence} miss${pr.evidence === 1 ? "" : "es"})`, value: clip(pr.why, 1000), inline: false }] : []),
      ],
      buttons: p.state === "open" ? [
        { customId: learnerCustomId("approve", p.id), label: "Approve", style: "success", emoji: "✅" },
        { customId: learnerCustomId("reject", p.id), label: "Reject", style: "secondary" },
      ] : [],
      ...(p.state === "open" ? { footer: "Only an approver can decide. Approving adds this wording; it removes nothing." } : {}),
    }
  }

  /** Post a report: one summary, then one card per proposed prompt change. */
  async post(chatId: string, r: LearnerReport): Promise<number> {
    const edits = r.proposals.filter(p => p.type === "prompt_edit" && p.text)
    await this.d.sendCard(chatId, this.summaryCard(r, edits.length))
    let posted = 0
    for (const proposal of edits) {
      const id = `${this.d.genId?.() ?? this.now().toString(36)}${(++this.seq).toString(36)}`
      const p: PendingEdit = { id, proposal, chatId, messageId: "", at: this.now(), state: "open" }
      const mid = await this.d.sendCard(chatId, this.editCard(p)).catch(() => undefined)
      if (!mid) continue
      p.messageId = mid; this.pending.set(id, p); posted++
    }
    this.save()
    return posted
  }

  /** May this person press this button at all? */
  mayPress(customId: string, userId: string): boolean {
    const c = parseLearnerCustomId(customId)
    const p = c && this.pending.get(c.id)
    return !!p && this.d.approversFor(p.proposal.agent).includes(userId)
  }

  /** An Approve or Reject press. A returned string ⇒ nothing happened. */
  click(customId: string, userId: string): string | undefined {
    const c = parseLearnerCustomId(customId)
    if (!c) return "That is not a Learner button."
    const p = this.pending.get(c.id)
    if (!p) return "This proposal is no longer open."
    if (p.state !== "open") return "This proposal has already been decided."
    if (!this.d.approversFor(p.proposal.agent).includes(userId)) return "Only an approver can decide this."
    p.by = userId
    if (c.verb === "reject") p.state = "rejected"
    else {
      const failed = this.d.applyPromptEdit(p.proposal.agent, learnedLine(p.proposal.text ?? "", this.now()), userId)
      p.state = failed ? "failed" : "approved"
      if (failed) process.stderr.write(`learner: apply failed for ${p.proposal.agent}: ${failed}\n`)
    }
    this.d.audit?.({ action: `learner.${c.verb}`, agent: p.proposal.agent, userId, outcome: p.state === "failed" ? "error" : "ok", detail: { summary: p.proposal.summary, evidence: p.proposal.evidence } })
    this.save()
    void this.d.editCard(p.chatId, p.messageId, this.editCard(p)).catch(() => {})
    return undefined
  }
}
