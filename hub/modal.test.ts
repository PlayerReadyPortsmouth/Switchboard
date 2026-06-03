import { test, expect } from "bun:test"
import { normalizeModalSpec, buildModal } from "./modal"
import type { CardModal } from "./types"

test("normalizeModalSpec clamps to 5 inputs, defaults style, clamps title", () => {
  const spec: CardModal = {
    title: "x".repeat(80),
    inputs: Array.from({ length: 7 }, (_, i) => ({
      id: `f${i}`, label: "", style: (i % 2 ? "paragraph" : "short") as any,
    })),
  }
  const n = normalizeModalSpec(spec)
  expect(n.title.length).toBe(45)
  expect(n.inputs.length).toBe(5)
  expect(n.inputs[0].label).toBe("f0")        // empty label falls back to id
  expect(n.inputs[1].style).toBe("paragraph")
})

test("normalizeModalSpec gives an empty/odd spec a safe default", () => {
  const n = normalizeModalSpec({ title: "", inputs: [] } as CardModal)
  expect(n.title).toBe("Input")
  expect(n.inputs).toEqual([])
})

test("buildModal produces a ModalBuilder with the customId and one row per input", () => {
  const modal = buildModal("fix:feedback:T1", {
    title: "Feedback", inputs: [{ id: "feedback", label: "Your note", style: "paragraph" }],
  })
  expect(modal.data.custom_id).toBe("fix:feedback:T1")
  expect(modal.components.length).toBe(1)
})
