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
  srv.onNotify((n) => { cards.push(n) })
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

import { test as st, expect as se } from "bun:test"
import { ShimSocketServer as SSS } from "../hub/transports/shimSocket"
import { encode as enc } from "../hub/framing"

st("dispatches update and finish wire messages to their callbacks", async () => {
  const path = join(tmpdir(), `sbtest-${process.pid}-${globalThis.performance.now()}.sock`)
  const srv = new SSS(path)
  let updated: any = null; let finished = false
  srv.onUpdate((u) => { updated = u })
  srv.onFinish(() => { finished = true })
  await srv.listen()
  const sock = await Bun.connect({ unix: path, socket: { data() {} } })
  sock.write(enc({ t: "update", chatId: "c", correlationId: "T1", card: { title: "x" } }))
  sock.write(enc({ t: "finish" }))
  await Bun.sleep(50)
  se(updated).toEqual({ chatId: "c", correlationId: "T1", card: { title: "x" } })
  se(finished).toBe(true)
  sock.end(); await srv.close()
})

st("remember reaches the callback; recall replies with notes keyed by id", async () => {
  const path = join(tmpdir(), `sbtest-mem-${process.pid}-${globalThis.performance.now()}.sock`)
  const srv = new SSS(path)
  let remembered: any = null
  srv.onRemember((r) => { remembered = r })
  srv.onRecall(async (q) => [{ title: `for:${q.query}`, body: "B" }])
  await srv.listen()

  const results: any[] = []
  const dec = new (await import("../hub/framing")).LineDecoder()
  const sock = await Bun.connect({ unix: path, socket: {
    data(_s, d) { for (const o of dec.push(d.toString())) results.push(o) },
  } })
  sock.write(enc({ t: "remember", scope: "global", title: "T", body: "B" }))
  sock.write(enc({ t: "recall", id: "q1", query: "alpha", scopes: ["global"] }))
  await Bun.sleep(80)

  se(remembered).toEqual({ scope: "global", title: "T", tags: undefined, body: "B" })
  se(results[0]).toEqual({ t: "recall_result", id: "q1", notes: [{ title: "for:alpha", body: "B" }] })
  sock.end(); await srv.close()
})

st("notify with an id writes a notify_result receipt from the cb outcome", async () => {
  const path = join(tmpdir(), `sbtest-rcpt-${process.pid}-${globalThis.performance.now()}.sock`)
  const srv = new SSS(path)
  srv.onNotify(() => ({ ok: true, messageId: "MSG99" }))
  await srv.listen()
  const results: any[] = []
  const dec = new (await import("../hub/framing")).LineDecoder()
  const sock = await Bun.connect({ unix: path, socket: {
    data(_s, d) { for (const o of dec.push(d.toString())) results.push(o) },
  } })
  sock.write(enc({ t: "notify", id: "n1", chatId: "c", card: { title: "T", body: "b", buttons: [] }, correlationId: "x" }))
  await Bun.sleep(80)
  se(results[0]).toEqual({ t: "notify_result", id: "n1", ok: true, messageId: "MSG99", error: undefined })
  sock.end(); await srv.close()
})

st("notify without an id writes no receipt (inert when receipts off)", async () => {
  const path = join(tmpdir(), `sbtest-noircpt-${process.pid}-${globalThis.performance.now()}.sock`)
  const srv = new SSS(path)
  let seen = false
  srv.onNotify(() => { seen = true; return { ok: true, messageId: "M" } })
  await srv.listen()
  const results: any[] = []
  const dec = new (await import("../hub/framing")).LineDecoder()
  const sock = await Bun.connect({ unix: path, socket: {
    data(_s, d) { for (const o of dec.push(d.toString())) results.push(o) },
  } })
  sock.write(enc({ t: "notify", chatId: "c", card: { title: "T", body: "b", buttons: [] }, correlationId: "x" }))
  await Bun.sleep(80)
  se(seen).toBe(true)
  se(results.length).toBe(0)
  sock.end(); await srv.close()
})

st("update with an id writes an update_result receipt", async () => {
  const path = join(tmpdir(), `sbtest-urcpt-${process.pid}-${globalThis.performance.now()}.sock`)
  const srv = new SSS(path)
  srv.onUpdate(async () => ({ ok: false, error: "unknown correlation" }))
  await srv.listen()
  const results: any[] = []
  const dec = new (await import("../hub/framing")).LineDecoder()
  const sock = await Bun.connect({ unix: path, socket: {
    data(_s, d) { for (const o of dec.push(d.toString())) results.push(o) },
  } })
  sock.write(enc({ t: "update", id: "u1", chatId: "c", correlationId: "T1", card: { title: "x" } }))
  await Bun.sleep(80)
  se(results[0]).toEqual({ t: "update_result", id: "u1", ok: false, messageId: undefined, error: "unknown correlation" })
  sock.end(); await srv.close()
})

st("attach with an id writes an attach_result receipt", async () => {
  const path = join(tmpdir(), `sbtest-arcpt-${process.pid}-${globalThis.performance.now()}.sock`)
  const srv = new SSS(path)
  srv.onAttach(async () => ({ ok: true }))
  await srv.listen()
  const results: any[] = []
  const dec = new (await import("../hub/framing")).LineDecoder()
  const sock = await Bun.connect({ unix: path, socket: {
    data(_s, d) { for (const o of dec.push(d.toString())) results.push(o) },
  } })
  sock.write(enc({ t: "attach", id: "at1", chatId: "c", path: "r.pdf" }))
  await Bun.sleep(80)
  se(results[0]).toEqual({ t: "attach_result", id: "at1", ok: true, messageId: undefined, error: undefined })
  sock.end(); await srv.close()
})

st("ask_agent reaches the callback; the answer is written back keyed by id", async () => {
  const path = join(tmpdir(), `sbtest-ask-${process.pid}-${globalThis.performance.now()}.sock`)
  const srv = new SSS(path)
  let asked: any = null
  srv.onAskAgent(async (q) => { asked = q; return `answer-for:${q.message}` })
  await srv.listen()

  const results: any[] = []
  const dec = new (await import("../hub/framing")).LineDecoder()
  const sock = await Bun.connect({ unix: path, socket: {
    data(_s, d) { for (const o of dec.push(d.toString())) results.push(o) },
  } })
  sock.write(enc({ t: "ask_agent", id: "a1", agent: "ops", message: "is prod ok?" }))
  await Bun.sleep(80)

  se(asked).toEqual({ agent: "ops", message: "is prod ok?" })
  se(results[0]).toEqual({ t: "ask_agent_result", id: "a1", answer: "answer-for:is prod ok?" })
  sock.end(); await srv.close()
})
