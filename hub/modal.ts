import { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } from "discord.js"
import type { CardModal } from "./types"

/** Clamp a CardModal to Discord's limits and fill safe defaults. */
export function normalizeModalSpec(m: CardModal): CardModal {
  const clip = (s: unknown, n: number) => (typeof s === "string" ? s.slice(0, n) : "")
  return {
    title: clip(m?.title, 45) || "Input",
    inputs: (m?.inputs ?? []).slice(0, 5).map((i) => ({
      id: i.id,
      label: clip(i.label, 45) || i.id,
      style: i.style === "paragraph" ? "paragraph" : "short",
      placeholder: i.placeholder ? clip(i.placeholder, 100) : undefined,
      required: i.required ?? false,
    })),
  }
}

/** Translate a (normalized) CardModal into a discord.js ModalBuilder. */
export function buildModal(customId: string, spec: CardModal): ModalBuilder {
  const n = normalizeModalSpec(spec)
  const modal = new ModalBuilder().setCustomId(customId.slice(0, 100)).setTitle(n.title)
  for (const inp of n.inputs) {
    const ti = new TextInputBuilder()
      .setCustomId(inp.id)
      .setLabel(inp.label)
      .setStyle(inp.style === "paragraph" ? TextInputStyle.Paragraph : TextInputStyle.Short)
      .setRequired(!!inp.required)
    if (inp.placeholder) ti.setPlaceholder(inp.placeholder)
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(ti))
  }
  return modal
}
