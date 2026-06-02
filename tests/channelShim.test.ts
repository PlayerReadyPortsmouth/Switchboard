import { test, expect } from "bun:test"
import { ChannelShimTransport } from "../hub/transports/channelShim"
import { encode, LineDecoder } from "../hub/framing"
import type { InboundMessage, AgentReply } from "../hub/types"
import { mkdtempSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

const inbound: InboundMessage = {
  chatId: "c", messageId: "m", userId: "u", user: "bob", content: "hi", ts: "t", isDM: true,
}

test("a registered shim becomes available; inbound reaches it; replies come back", async () => {
  const sock = join(mkdtempSync(join(tmpdir(), "sb-sock-")), "hub.sock")
  const t = new ChannelShimTransport("research", sock)
  await t.listen()

  expect(t.isAvailable()).toBe(false)            // nothing connected yet

  // Connect a fake shim client.
  const received: any[] = []
  const dec = new LineDecoder()
  const client = await Bun.connect({
    unix: sock,
    socket: { data(_s, d) { for (const o of dec.push(d.toString())) received.push(o) } },
  })
  client.write(encode({ t: "register", agent: "research" }))
  await Bun.sleep(20)
  expect(t.isAvailable()).toBe(true)

  const replies: AgentReply[] = []
  t.onReply(r => replies.push(r))

  t.deliver("dm:u", inbound)
  await Bun.sleep(20)
  expect(received.find(o => o.t === "inbound")?.inbound.content).toBe("hi")

  client.write(encode({ t: "reply", chatId: "c", text: "hello back", replyTo: "m" }))
  await Bun.sleep(20)
  expect(replies[0]).toMatchObject({ agent: "research", kind: "reply", text: "hello back" })

  client.end()
  await t.close()
})

test("availability drops when the shim disconnects", async () => {
  const sock = join(mkdtempSync(join(tmpdir(), "sb-sock-")), "hub.sock")
  const t = new ChannelShimTransport("research", sock)
  await t.listen()
  const client = await Bun.connect({ unix: sock, socket: { data() {} } })
  client.write(encode({ t: "register", agent: "research" }))
  await Bun.sleep(20)
  expect(t.isAvailable()).toBe(true)
  client.end()
  await Bun.sleep(20)
  expect(t.isAvailable()).toBe(false)
  await t.close()
})
