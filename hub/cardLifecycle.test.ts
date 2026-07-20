import { test, expect } from "bun:test"
import { CardLifecycle } from "./cardLifecycle"
import { CardRegistry } from "./cardRegistry"
import type { AgentReply, CardSpec, GatedAction } from "./types"

function fakeDeps() {
  const calls: any = { sent: [], edited: [], registered: [], forgot: [], modalsReg: [], modalsUnreg: [], closed: [], commands: [], published: [] }
  let nextMsgId = 1
  let exitCode = 0
  return {
    calls, setExit: (c: number) => { exitCode = c },
    deps: {
      sendCard: async (chatId: string, card: CardSpec) => { calls.sent.push({ chatId, card }); return `msg-${nextMsgId++}` },
      editCard: async (chatId: string, messageId: string, card: CardSpec) => { calls.edited.push({ chatId, messageId, card }) },
      registerButtons: (ids: string[], key: string) => calls.registered.push({ ids, key }),
      forgetButtons: (ids: string[]) => calls.forgot.push(ids),
      registerModals: (card: CardSpec) => calls.modalsReg.push(card.buttons.filter((b) => b.modal).map((b) => b.customId)),
      unregisterModals: (ids: string[]) => calls.modalsUnreg.push(ids),
      ownerOf: (customId: string) => (customId.includes("job-9") ? "job-9" : undefined),
      closeTransport: (key: string) => calls.closed.push(key),
      runCommand: async (cmd: string) => { calls.commands.push(cmd); return exitCode },
      publishCard: (correlationId: string, chatId: string, card: CardSpec) =>
        calls.published.push({ correlationId, chatId, body: card.body, buttons: card.buttons.length }),
    },
  }
}

const card = (corr: string, ids: string[]): CardSpec => ({
  title: `T ${corr}`, body: "b", buttons: ids.map((id) => ({ customId: id, label: id })),
})

test("onCard sends, registers buttons + modals, and records the message", async () => {
  const reg = new CardRegistry(); const f = fakeDeps()
  const lc = new CardLifecycle(reg, f.deps)
  const reply: AgentReply = { agent: "triage", kind: "card", chatId: "chan", correlationId: "T1", card: card("T1", ["t:fixnow:T1"]) }
  await lc.onCard(reply, "triage")
  expect(f.calls.sent.length).toBe(1)
  expect(f.calls.registered[0]).toEqual({ ids: ["t:fixnow:T1"], key: "triage" })
  expect(reg.get("T1")).toMatchObject({ messageId: "msg-1" })
})

test("onUpdate edits in place, forgetting superseded buttons", async () => {
  const reg = new CardRegistry(); const f = fakeDeps()
  const lc = new CardLifecycle(reg, f.deps)
  await lc.onCard({ agent: "triage", kind: "card", chatId: "chan", correlationId: "T1", card: card("T1", ["t:fixnow:T1", "t:close:T1"]) }, "triage")
  await lc.onUpdate("T1", "chan", card("T1", ["fix:cancel:job-9"]), "job-9")
  expect(f.calls.edited.length).toBe(1)
  expect(f.calls.edited[0].messageId).toBe("msg-1")        // same message, edited
  expect(f.calls.forgot[0].sort()).toEqual(["t:close:T1", "t:fixnow:T1"])
  expect(f.calls.registered.at(-1)).toEqual({ ids: ["fix:cancel:job-9"], key: "job-9" })
})

test("onUpdate falls back to posting fresh when the correlation is unknown", async () => {
  const reg = new CardRegistry(); const f = fakeDeps()
  const lc = new CardLifecycle(reg, f.deps)
  await lc.onUpdate("ghost", "chan", card("ghost", ["a:b:c"]), "k")
  expect(f.calls.sent.length).toBe(1)
  expect(f.calls.edited.length).toBe(0)
  expect(reg.get("ghost")).toBeDefined()
})

const gated: GatedAction[] = [
  { namespace: "deploy", action: "go", approverOnly: true, command: "deploy.sh $arg",
    terminateAgent: true, pendingText: "Deploying #$arg…", successText: "✅ Deployed", failureText: "❌ Failed" },
]

test("runGated edits pending→success, runs the command, and tears down the agent on success", async () => {
  const reg = new CardRegistry(); const f = fakeDeps()
  const lc = new CardLifecycle(reg, f.deps)
  await lc.onCard({ agent: "fix", kind: "card", chatId: "chan", correlationId: "T1", card: card("T1", ["deploy:go:55", "fix:cancel:job-9"]) }, "job-9")
  await lc.runGated(gated[0], "deploy:go:55")
  expect(f.calls.commands).toEqual(["deploy.sh 55"])
  const bodies = f.calls.edited.map((e: any) => e.card.body)
  expect(bodies[0]).toBe("Deploying #55…")
  expect(bodies.at(-1)).toBe("✅ Deployed")
  expect(f.calls.closed).toEqual(["job-9"])
})

// The regression this whole change exists for. A `deploy:*` button runs entirely hub-side:
// it never produces an agent reply, so onAgentReply's canonical publish never runs for it.
// Before the fix these two edits went to Discord and NOWHERE else — the web card kept the
// original text and its original, still-clickable buttons while the deploy ran and finished.
test("runGated publishes BOTH edits canonically, so the web card follows Discord", async () => {
  const reg = new CardRegistry(); const f = fakeDeps()
  const lc = new CardLifecycle(reg, f.deps)
  await lc.onCard({ agent: "fix", kind: "card", chatId: "chan", correlationId: "T1", card: card("T1", ["deploy:go:55", "fix:cancel:job-9"]) }, "job-9")
  await lc.runGated(gated[0], "deploy:go:55")

  expect(f.calls.published.map((p: any) => p.body)).toEqual(["Deploying #55…", "✅ Deployed"])
  // Same correlation and chat the Discord edit used — one card moving forward, not a second
  // card appearing on the web beside the stale original.
  expect(f.calls.published.every((p: any) => p.correlationId === "T1" && p.chatId === "chan")).toBe(true)
  // And the published state is button-less, matching what Discord now shows.
  expect(f.calls.published.every((p: any) => p.buttons === 0)).toBe(true)
  // Discord is still edited first: a canonical publish must never precede the surface the
  // operator is actually watching.
  expect(f.calls.edited.length).toBe(f.calls.published.length)
})

test("runGated on a failed command publishes the failure text too", async () => {
  const reg = new CardRegistry(); const f = fakeDeps(); f.setExit(1)
  const lc = new CardLifecycle(reg, f.deps)
  await lc.onCard({ agent: "fix", kind: "card", chatId: "chan", correlationId: "T1", card: card("T1", ["deploy:go:55"]) }, "job-9")
  await lc.runGated(gated[0], "deploy:go:55")
  expect(f.calls.published.at(-1).body).toBe("❌ Failed")
})

test("runGated on an unknown correlation publishes nothing (there is no card to move)", async () => {
  const reg = new CardRegistry(); const f = fakeDeps()
  const lc = new CardLifecycle(reg, f.deps)
  await lc.runGated(gated[0], "deploy:go:55")
  expect(f.calls.published).toEqual([])
  expect(f.calls.edited).toEqual([])
})

test("runGated does NOT tear down the agent on failure", async () => {
  const reg = new CardRegistry(); const f = fakeDeps(); f.setExit(1)
  const lc = new CardLifecycle(reg, f.deps)
  await lc.onCard({ agent: "fix", kind: "card", chatId: "chan", correlationId: "T1", card: card("T1", ["deploy:go:55", "fix:cancel:job-9"]) }, "job-9")
  await lc.runGated(gated[0], "deploy:go:55")
  expect(f.calls.edited.at(-1).card.body).toBe("❌ Failed")
  expect(f.calls.closed).toEqual([])
})
