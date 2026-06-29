import { createHmac, timingSafeEqual, randomUUID } from "node:crypto"
import type { Socket } from "bun"
import { LineDecoder, encode } from "./framing"
import type { FederationConfig } from "./types"

/** A resolved peer: its name, where to dial it, and the shared HMAC key (read
 *  from env at startup so secrets never live in config). */
export interface FederationPeer {
  name: string
  addr: string      // "host:port"
  authKey: string
}

/** Runtime view of federation: the local listener bind + the dialable peers. */
export interface ResolvedFederation {
  selfName: string                       // this hub's federation identity
  host: string                           // listener bind host (from listenAddr)
  port: number                           // listener bind port (from listenAddr)
  peers: Record<string, FederationPeer>  // remote hub name → dial target + key
}

/** Split a "host:port" into parts. Throws on a malformed value (caught at config
 *  validation time). Uses the LAST colon so IPv6-less host:port stays simple. */
export function parseHostPort(addr: string): { host: string; port: number } {
  const i = addr.lastIndexOf(":")
  if (i <= 0 || i === addr.length - 1) {
    throw new Error(`federation: invalid address "${addr}" (expected host:port)`)
  }
  const host = addr.slice(0, i)
  const port = Number(addr.slice(i + 1))
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`federation: invalid port in "${addr}"`)
  }
  return { host, port }
}

/** Build the runtime view from config + env. Returns null when federation is off.
 *  Peers whose authKey env is unset are dropped (with no key we can neither sign
 *  outbound nor verify inbound). */
export function resolveFederation(
  cfg: FederationConfig | undefined,
  env: Record<string, string | undefined>,
): ResolvedFederation | null {
  if (!cfg?.enabled) return null
  const { host, port } = parseHostPort(cfg.listenAddr)
  const peers: Record<string, FederationPeer> = {}
  for (const [name, p] of Object.entries(cfg.peers ?? {})) {
    const authKey = env[p.authKeyEnv]
    if (!authKey) continue
    peers[name] = { name, addr: p.addr, authKey }
  }
  return { selfName: cfg.name, host, port, peers }
}

/** A consult target addresses a remote hub when it carries a "<hub>:<agent>"
 *  prefix. Local agent names never contain a colon. */
export function isRemoteTarget(target: string): boolean {
  return target.includes(":")
}

/** Split "<hub>:<agent>" on the FIRST colon (agent may itself be unqualified). */
export function splitRemoteTarget(target: string): { hub: string; agent: string } {
  const i = target.indexOf(":")
  return { hub: target.slice(0, i), agent: target.slice(i + 1) }
}

/** A consult crossing hubs. `from` is "<sourceHub>:<agent>", `to` is the bare
 *  local agent name on the receiving hub. `mac` is the HMAC over the canonical
 *  body (see signRequest). */
export interface FedConsultRequest {
  t: "consult_request"
  id: string
  from: string
  to: string
  message: string
  mac: string
}

export interface FedConsultResponse {
  t: "consult_response"
  id: string
  answer?: string
  error?: string
}

/** Canonical bytes signed/verified: the request minus its own mac. Stable key
 *  order so both ends compute the same string. */
function canonicalRequest(r: { id: string; from: string; to: string; message: string }): string {
  return JSON.stringify({ id: r.id, from: r.from, to: r.to, message: r.message })
}

export function signRequest(authKey: string, r: { id: string; from: string; to: string; message: string }): string {
  return createHmac("sha256", authKey).update(canonicalRequest(r)).digest("hex")
}

/** Constant-time verify of a request's mac against the peer's shared key. */
export function verifyRequest(authKey: string, r: FedConsultRequest): boolean {
  if (!authKey || !r.mac) return false
  const expected = signRequest(authKey, r)
  const a = Buffer.from(r.mac)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** What the listener does with a verified inbound consult: dispatch it to a local
 *  target agent and resolve with its answer (reuses the hub's local consult
 *  plumbing). */
export interface FederationListenerDeps {
  consultLocal: (req: { from: string; to: string; message: string }) => Promise<string>
}

/** Pure request handler (testable without sockets). Identifies the source peer
 *  from `from`, verifies the mac with that peer's key, then dispatches locally.
 *  An unknown peer or bad signature returns an error response (never dispatches). */
export async function handleFederationRequest(
  frame: FedConsultRequest,
  fed: ResolvedFederation,
  deps: FederationListenerDeps,
): Promise<FedConsultResponse> {
  const { hub } = splitRemoteTarget(frame.from)
  const peer = fed.peers[hub]
  if (!peer) return { t: "consult_response", id: frame.id, error: `unknown peer "${hub}"` }
  if (!verifyRequest(peer.authKey, frame)) {
    return { t: "consult_response", id: frame.id, error: "bad signature" }
  }
  try {
    const answer = await deps.consultLocal({ from: frame.from, to: frame.to, message: frame.message })
    return { t: "consult_response", id: frame.id, answer }
  } catch (e) {
    return { t: "consult_response", id: frame.id, error: String(e) }
  }
}

/** Stand up the per-hub federation listener on `fed.host:fed.port`. Line-framed
 *  JSON over TCP (same framing as the shim socket); each verified consult_request
 *  is handled and its response written back on the same connection. Returns the
 *  actual bound port (so port 0 can be used in tests) plus a stop fn. */
export function startFederationListener(
  fed: ResolvedFederation,
  deps: FederationListenerDeps,
): { stop: () => void; port: number } {
  const server = Bun.listen({
    hostname: fed.host,
    port: fed.port,
    socket: {
      open(socket) { (socket as unknown as { __d: LineDecoder }).__d = new LineDecoder() },
      data(socket, data) {
        const dec = (socket as unknown as { __d: LineDecoder }).__d
        for (const obj of dec.push(data.toString())) {
          const frame = obj as FedConsultRequest
          if (frame?.t !== "consult_request") continue
          void handleFederationRequest(frame, fed, deps).then((res) => {
            try { socket.write(encode(res)) } catch {}
          })
        }
      },
    },
  })
  return { stop: () => server.stop(true), port: server.port }
}

/** Dial the named peer and consult a remote agent, returning its answer (or a
 *  parenthesized error note, matching the local consult convention). Resolves on
 *  the matching response, a timeout, or a connection failure. */
export async function consultRemote(
  fed: ResolvedFederation,
  target: string,
  message: string,
  requester: string,
  timeoutMs: number,
): Promise<string> {
  const { hub, agent } = splitRemoteTarget(target)
  const peer = fed.peers[hub]
  if (!peer) return `(unknown federation peer "${hub}")`
  let host: string
  let port: number
  try { ({ host, port } = parseHostPort(peer.addr)) }
  catch { return `(bad address for federation peer "${hub}")` }

  const req: FedConsultRequest = {
    t: "consult_request", id: randomUUID(),
    from: `${fed.selfName}:${requester}`, to: agent, message, mac: "",
  }
  req.mac = signRequest(peer.authKey, req)

  return new Promise<string>((resolve) => {
    let done = false
    let sock: Socket<unknown> | undefined
    const dec = new LineDecoder()
    const finish = (s: string) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { sock?.end() } catch {}
      resolve(s)
    }
    const timer = setTimeout(() => finish(`(remote consult to "${target}" timed out)`), timeoutMs)
    Bun.connect({
      hostname: host, port,
      socket: {
        open(s) {
          sock = s
          try { s.write(encode(req)) }
          catch { finish(`(could not reach federation peer "${hub}")`) }
        },
        data(_s, data) {
          for (const obj of dec.push(data.toString())) {
            const res = obj as FedConsultResponse
            if (res?.t === "consult_response" && res.id === req.id) {
              finish(res.answer ?? `(remote consult error: ${res.error ?? "unknown"})`)
            }
          }
        },
        error() { finish(`(could not reach federation peer "${hub}")`) },
        close() { finish(`(federation peer "${hub}" closed the connection)`) },
      },
    }).catch(() => finish(`(could not reach federation peer "${hub}")`))
  })
}
