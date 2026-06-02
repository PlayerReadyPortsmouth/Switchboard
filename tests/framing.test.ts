import { test, expect } from "bun:test"
import { encode, LineDecoder } from "../hub/framing"

test("encode appends a newline", () => {
  expect(encode({ t: "ping" })).toBe('{"t":"ping"}\n')
})

test("decoder emits complete objects and buffers partials", () => {
  const dec = new LineDecoder()
  expect(dec.push('{"a":1}\n{"b":')).toEqual([{ a: 1 }])
  expect(dec.push('2}\n')).toEqual([{ b: 2 }])
})

test("decoder handles multiple objects in one chunk", () => {
  const dec = new LineDecoder()
  expect(dec.push('{"a":1}\n{"b":2}\n')).toEqual([{ a: 1 }, { b: 2 }])
})
