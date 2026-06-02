import { test, expect } from "bun:test"
import { makeHeadlessRunner } from "../hub/transports/spawnClaude"
import { mkdtempSync, writeFileSync, chmodSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

test("runner invokes the binary and returns stdout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-bin-"))
  const stub = join(dir, "fakeclaude")
  writeFileSync(stub, '#!/bin/sh\ncat > /dev/null\necho \'{"result":"hi","session_id":"s1"}\'\n')
  chmodSync(stub, 0o755)
  const run = makeHeadlessRunner(stub)
  const { stdout } = await run(["-p"], "hello", dir, 5000)
  expect(JSON.parse(stdout).result).toBe("hi")
})

test("runner rejects when the binary exceeds the timeout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sb-bin-"))
  const stub = join(dir, "slowclaude")
  writeFileSync(stub, '#!/bin/sh\nsleep 5\n')
  chmodSync(stub, 0o755)
  const run = makeHeadlessRunner(stub)
  await expect(run(["-p"], "x", dir, 200)).rejects.toThrow()
})
