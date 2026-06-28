// hub/memoryCard.ts
import type { CardSpec } from "./types"

export interface NoteSummary { path: string; scope: string; title: string; tags: string[]; source: string; updated: string }
export type MemAction = "view" | "forget" | "del" | "confirm" | "confirmdel" | "cancel" | "prev" | "next"

/** `mem:<action>:<corrId>[:<idx>]`. The hub's parseNotifyCustomId yields
 *  ns="mem", action=<action>, arg=<corrId>[:<idx>] (its arg capture is greedy). */
export function encodeMemId(action: MemAction, corrId: string, idx?: number): string {
  return idx === undefined ? `mem:${action}:${corrId}` : `mem:${action}:${corrId}:${idx}`
}
export function parseMemArg(arg: string): { corrId: string; idx?: number } {
  const i = arg.indexOf(":")
  if (i < 0) return { corrId: arg }
  const idx = Number(arg.slice(i + 1))
  return { corrId: arg.slice(0, i), idx: Number.isFinite(idx) ? idx : undefined }
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s)

export function renderListCard(notes: NoteSummary[], corrId: string, page: number, pageCount: number, label: string): CardSpec {
  const fields = notes.map((n, i) => ({
    name: `${i}. ${clip(n.title, 80)}`,
    value: `\`${n.scope}\` · ${n.source}${n.tags.length ? " · " + n.tags.map(t => `#${t}`).join(" ") : ""}`,
  }))
  if (!fields.length) fields.push({ name: "—", value: "_no notes in this view_" })
  const buttons: CardSpec["buttons"] = []
  notes.forEach((_, i) => {
    buttons.push({ customId: encodeMemId("view", corrId, i), label: `View ${i}`, style: "secondary" })
    buttons.push({ customId: encodeMemId("forget", corrId, i), label: `Forget ${i}`, style: "danger" })
  })
  if (pageCount > 1) {
    buttons.push({ customId: encodeMemId("prev", corrId), label: "◀ Prev", style: "primary" })
    buttons.push({ customId: encodeMemId("next", corrId), label: "Next ▶", style: "primary" })
  }
  return {
    title: `🧠 Vault — ${label}` + (pageCount > 1 ? ` (page ${page + 1}/${pageCount})` : ""),
    body: "Browse notes. **View** to read, **Forget** to archive (reversible).",
    fields,
    buttons: buttons.slice(0, 25),
  }
}

export function renderDetailCard(note: { title: string; scope: string; tags: string[]; source: string; updated: string; body: string }, corrId: string, idx: number): CardSpec {
  return {
    title: `🧠 ${clip(note.title, 240)}`,
    body: clip(note.body || "_(empty)_", 4000),
    fields: [{ name: "scope", value: `\`${note.scope}\``, inline: true }, { name: "source", value: note.source, inline: true },
             { name: "updated", value: note.updated, inline: true }, { name: "tags", value: note.tags.length ? note.tags.map(t => `#${t}`).join(" ") : "—", inline: true }],
    buttons: [
      { customId: encodeMemId("forget", corrId, idx), label: "Forget (archive)", style: "danger" },
      { customId: encodeMemId("del", corrId, idx), label: "Delete permanently", style: "danger" },
    ],
  }
}

export function renderConfirmCard(kind: "forget" | "del", title: string, corrId: string, idx: number): CardSpec {
  const body = kind === "forget"
    ? `Archive **${clip(title, 200)}**? It leaves recall but can be restored.`
    : `Permanently delete **${clip(title, 200)}**? This cannot be undone.`
  return {
    title: kind === "forget" ? "Archive note?" : "Delete note permanently?",
    body,
    buttons: [
      { customId: encodeMemId(kind === "del" ? "confirmdel" : "confirm", corrId, idx), label: "Confirm", style: kind === "del" ? "danger" : "primary" },
      { customId: encodeMemId("cancel", corrId, idx), label: "Cancel", style: "secondary" },
    ],
  }
}
