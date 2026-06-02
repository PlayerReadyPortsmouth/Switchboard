import { test, expect } from "bun:test"
import { HeadlessTransport } from "../hub/transports/headless"
import type { AgentConfig, InboundMessage, AgentReply } from "../hub/types"

const cfg: AgentConfig = {
  emoji: "💡", description: "", mode: "ephemeral",
  access: { roles: ["*"] }, runtime: { cwd: ".", model: "claude-haiku-4-5", allowedTools: ["Read"] },
}
const inbound: InboundMessage = {
  chatId: "c", messageId: "m", userId: "u", user: "bob", content: "what is 2+2?", ts: "t", isDM: true,
}

test("delivers a reply from the headless runner", async () => {
  const runs: { args: string[]; stdin: string }[] = []
  const run = async (args: string[], stdin: string) => {
    runs.push({ args, stdin })
    return { stdout: JSON.stringify({ result: "4", session_id: "sess-1" }) }
  }
  const t = new HeadlessTransport("qa", cfg, run, 5000)
  const got: AgentReply[] = []
  t.onReply(r => got.push(r))
  t.deliver("dm:u", inbound)
  await Bun.sleep(10)
  expect(got[0].text).toBe("4")
  expect(got[0].agent).toBe("qa")
  expect(runs[0].args).toContain("--allowedTools")
})

test("resumes with the stored session id on the second turn", async () => {
  const seen: string[] = []
  const run = async (args: string[]) => {
    const i = args.indexOf("--resume")
    seen.push(i >= 0 ? args[i + 1] : "(none)")
    return { stdout: JSON.stringify({ result: "ok", session_id: "sess-1" }) }
  }
  const t = new HeadlessTransport("qa", cfg, run, 5000)
  t.onReply(() => {})
  t.deliver("dm:u", inbound); await Bun.sleep(10)
  t.deliver("dm:u", inbound); await Bun.sleep(10)
  expect(seen[0]).toBe("(none)")
  expect(seen[1]).toBe("sess-1")
})

test("a runner timeout/throw produces an apology reply", async () => {
  const run = async () => { throw new Error("timeout") }
  const t = new HeadlessTransport("qa", cfg, run, 5000)
  const got: AgentReply[] = []
  t.onReply(r => got.push(r))
  t.deliver("dm:u", inbound)
  await Bun.sleep(10)
  expect(got[0].text?.toLowerCase()).toContain("couldn't")
})
