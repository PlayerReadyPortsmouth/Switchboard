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
