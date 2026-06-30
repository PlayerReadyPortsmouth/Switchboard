import { test, expect } from "bun:test"
import { ShimSocketServer } from "./shimSocket"

test("an attach frame is routed to the onAttach callback", () => {
  const srv = new ShimSocketServer("/tmp/unused-attach.sock")
  let got: any = null
  srv.onAttach((a) => { got = a })
  // dispatch is private; exercise it directly (no socket needed for a fire-and-forget frame).
  ;(srv as any).dispatch(
    { t: "attach", chatId: "C1", path: "report.pdf", caption: "done", filename: "Report.pdf" },
    { write() {} },
  )
  expect(got).toEqual({ chatId: "C1", path: "report.pdf", caption: "done", filename: "Report.pdf" })
})

test("dispatch notify_peer fires onNotifyPeer", () => {
  const s = new ShimSocketServer("/tmp/x.sock")
  let got: any = null
  s.onNotifyPeer((n) => { got = n })
  // @ts-expect-error reach private dispatch for a unit check
  s.dispatch({ t: "notify_peer", target: "p:agent", text: "hi" }, { write() {} } as any)
  expect(got).toEqual({ target: "p:agent", text: "hi" })
})

test("dispatch ask_peer writes ask_peer_result with the answer", async () => {
  const s = new ShimSocketServer("/tmp/x.sock")
  s.onAskPeer(async () => "the answer")
  const writes: string[] = []
  // @ts-expect-error private dispatch
  s.dispatch({ t: "ask_peer", id: "a1", target: "p:agent", message: "q" },
    { write: (b: string) => writes.push(b) } as any)
  await new Promise((r) => setTimeout(r, 5))
  expect(writes.join("")).toContain("ask_peer_result")
  expect(writes.join("")).toContain("the answer")
})
