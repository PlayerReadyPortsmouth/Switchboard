import { test, expect } from "bun:test"
import { ShimSocketServer } from "../hub/transports/shimSocket"
import { encode } from "../hub/framing"
import { connect } from "bun"
import { tmpdir } from "os"
import { join } from "path"

function tmpSock() { return join(tmpdir(), `sb-shimsock-${Math.floor(performance.now())}-${process.pid}.sock`) }

test("receives register, notify, react, edit from a connected shim", async () => {
  const path = tmpSock()
  const srv = new ShimSocketServer(path)
  let registered = false
  const cards: any[] = []; const reacts: any[] = []; const edits: any[] = []
  srv.onRegister(() => { registered = true })
  srv.onNotify((n) => cards.push(n))
  srv.onReact((r) => reacts.push(r))
  srv.onEdit((e) => edits.push(e))
  await srv.listen()

  const client = await connect({ unix: path, socket: { data() {} } })
  client.write(encode({ t: "register", agent: "a" }))
  client.write(encode({ t: "notify", chatId: "c1", card: { title: "T", body: "b", buttons: [] }, correlationId: "x" }))
  client.write(encode({ t: "react", chatId: "c1", messageId: "m1", emoji: "✅" }))
  client.write(encode({ t: "edit", chatId: "c1", messageId: "m1", text: "new" }))

  const start = performance.now()
  while ((!registered || cards.length === 0 || reacts.length === 0 || edits.length === 0) && performance.now() - start < 3000) {
    await new Promise((r) => setTimeout(r, 20))
  }
  expect(registered).toBe(true)
  expect(srv.isRegistered()).toBe(true)
  expect(cards[0]).toEqual({ chatId: "c1", card: { title: "T", body: "b", buttons: [] }, correlationId: "x" })
  expect(reacts[0]).toEqual({ chatId: "c1", messageId: "m1", emoji: "✅" })
  expect(edits[0]).toEqual({ chatId: "c1", messageId: "m1", text: "new" })
  client.end(); await srv.close()
})
