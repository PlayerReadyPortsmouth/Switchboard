import { test, expect } from "bun:test"
import {
  parseHostPort, resolveFederation, isRemoteTarget, splitRemoteTarget,
  signRequest, verifyRequest, handleFederationRequest, startFederationListener, consultRemote,
  type ResolvedFederation, type FedConsultRequest,
} from "../hub/federation"
import type { FederationConfig } from "../hub/types"

const KEY = "shared-secret"

const fed = (over: Partial<ResolvedFederation> = {}): ResolvedFederation => ({
  selfName: "bravo", host: "127.0.0.1", port: 0,
  peers: { alpha: { name: "alpha", addr: "127.0.0.1:1", authKey: KEY } },
  ...over,
})

const req = (over: Partial<FedConsultRequest> = {}): FedConsultRequest => {
  const base = { t: "consult_request" as const, id: "r1", from: "alpha:dev", to: "qa", message: "hi", mac: "" }
  const m = { ...base, ...over }
  if (!over.mac) m.mac = signRequest(KEY, m)
  return m
}

// ---- parseHostPort ----

test("parseHostPort splits host:port and rejects malformed values", () => {
  expect(parseHostPort("10.0.0.1:9920")).toEqual({ host: "10.0.0.1", port: 9920 })
  expect(() => parseHostPort("nope")).toThrow(/host:port/)
  expect(() => parseHostPort("h:0")).toThrow(/port/)
  expect(() => parseHostPort("h:99999")).toThrow(/port/)
  expect(() => parseHostPort("h:")).toThrow(/host:port/)
})

// ---- resolveFederation ----

test("resolveFederation returns null when disabled", () => {
  expect(resolveFederation(undefined, {})).toBeNull()
  const cfg: FederationConfig = { enabled: false, name: "bravo", listenAddr: "127.0.0.1:9920", peers: {} }
  expect(resolveFederation(cfg, {})).toBeNull()
})

test("resolveFederation reads peer keys from env and drops peers with no key", () => {
  const cfg: FederationConfig = {
    enabled: true, name: "bravo", listenAddr: "127.0.0.1:9920",
    peers: { alpha: { addr: "10.0.0.1:9920", authKeyEnv: "K_ALPHA" }, ghost: { addr: "10.0.0.2:9920", authKeyEnv: "K_MISSING" } },
  }
  const r = resolveFederation(cfg, { K_ALPHA: "abc" })!
  expect(r.selfName).toBe("bravo")
  expect(r.host).toBe("127.0.0.1")
  expect(r.port).toBe(9920)
  expect(Object.keys(r.peers)).toEqual(["alpha"])
  expect(r.peers.alpha.authKey).toBe("abc")
})

// ---- target addressing ----

test("isRemoteTarget / splitRemoteTarget recognise <hub>:<agent>", () => {
  expect(isRemoteTarget("ready:dev-ori")).toBe(true)
  expect(isRemoteTarget("qa")).toBe(false)
  expect(splitRemoteTarget("ready:dev-ori")).toEqual({ hub: "ready", agent: "dev-ori" })
})

// ---- sign / verify ----

test("verifyRequest accepts a correct mac and rejects tampering or a wrong key", () => {
  const r = req()
  expect(verifyRequest(KEY, r)).toBe(true)
  expect(verifyRequest("other", r)).toBe(false)
  expect(verifyRequest(KEY, { ...r, message: "tampered" })).toBe(false)
  expect(verifyRequest(KEY, { ...r, mac: "" })).toBe(false)
})

// ---- handleFederationRequest (pure dispatch) ----

test("handleFederationRequest dispatches a verified consult to the local target", async () => {
  const seen: { from: string; to: string; message: string }[] = []
  const res = await handleFederationRequest(req(), fed(), {
    consultLocal: async (r) => { seen.push(r); return `echo:${r.message}` },
  })
  expect(res).toEqual({ t: "consult_response", id: "r1", answer: "echo:hi" })
  expect(seen[0]).toEqual({ from: "alpha:dev", to: "qa", message: "hi" })
})

test("handleFederationRequest rejects an unknown peer without dispatching", async () => {
  let called = false
  const res = await handleFederationRequest(req({ from: "stranger:dev", mac: "x" }), fed(), {
    consultLocal: async () => { called = true; return "x" },
  })
  expect(res.error).toMatch(/unknown peer/)
  expect(called).toBe(false)
})

test("handleFederationRequest rejects a bad signature without dispatching", async () => {
  let called = false
  const res = await handleFederationRequest(req({ mac: "deadbeef" }), fed(), {
    consultLocal: async () => { called = true; return "x" },
  })
  expect(res.error).toBe("bad signature")
  expect(called).toBe(false)
})

// ---- end-to-end loopback round-trip (real listener + real client) ----

test("consultRemote round-trips a consult to a remote hub and returns the answer", async () => {
  // Receiving hub "bravo" knows peer "alpha"; dispatch echoes the message.
  const server = startFederationListener(fed(), {
    consultLocal: async ({ from, to, message }) => `bravo(${to}) got "${message}" from ${from}`,
  })
  try {
    // Calling hub "alpha" knows peer "bravo" at the bound port, same shared key.
    const client = fed({
      selfName: "alpha",
      peers: { bravo: { name: "bravo", addr: `127.0.0.1:${server.port}`, authKey: KEY } },
    })
    const answer = await consultRemote(client, "bravo:qa", "ping", "dev", 2000)
    expect(answer).toBe('bravo(qa) got "ping" from alpha:dev')
  } finally {
    server.stop()
  }
})

test("consultRemote surfaces a remote auth rejection as an error note", async () => {
  const server = startFederationListener(fed(), { consultLocal: async () => "should not run" })
  try {
    const client = fed({
      selfName: "alpha",
      peers: { bravo: { name: "bravo", addr: `127.0.0.1:${server.port}`, authKey: "WRONG-KEY" } },
    })
    const answer = await consultRemote(client, "bravo:qa", "ping", "dev", 2000)
    expect(answer).toMatch(/bad signature/)
  } finally {
    server.stop()
  }
})

test("consultRemote returns an error note for an unknown peer", async () => {
  const answer = await consultRemote(fed({ selfName: "alpha", peers: {} }), "nope:qa", "ping", "dev", 500)
  expect(answer).toMatch(/unknown federation peer/)
})
