import { test, expect } from "bun:test"
import { DASHBOARD_HTML } from "./web"

test("the dashboard polls a RELATIVE api/status (works under a subpath mount)", () => {
  expect(DASHBOARD_HTML).toContain("fetch('api/status')")
  expect(DASHBOARD_HTML).not.toContain("fetch('/api/status')")
})
