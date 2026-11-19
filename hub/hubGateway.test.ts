import { describe, expect, test } from "bun:test"
import { createHash, createHmac } from "crypto"
import { GatewayError, HubGatewayClient, explain, renderCatalog, signRequest } from "./hubGateway"

const AURORA = "186188409499418628"

describe("signRequest", () => {
  test("signs method, path with query, timestamp, nonce and the body hash", () => {
    const h = signRequest("s3cret", "hub:skippy-4", "post", "/hub/v1/actions/propose", '{"a":1}', 1700000000000, "n0nce")
    const expected = createHmac("sha256", "s3cret")
      .update(["POST", "/hub/v1/actions/propose", "1700000000000", "n0nce", createHash("sha256").update('{"a":1}').digest("hex")].join("\n")).digest("hex")
    expect(h).toEqual({ "x-hub-client": "hub:skippy-4", "x-hub-timestamp": "1700000000000", "x-hub-nonce": "n0nce", "x-hub-signature": expected })
  })
  test("any change to what is signed changes the signature", () => {
    const base = signRequest("s", "c", "GET", "/p?x=1", "", 1, "n")["x-hub-signature"]
    expect(signRequest("s", "c", "GET", "/p?x=2", "", 1, "n")["x-hub-signature"]).not.toBe(base)
    expect(signRequest("s", "c", "GET", "/p?x=1", "", 2, "n")["x-hub-signature"]).not.toBe(base)
    expect(signRequest("s", "c", "GET", "/p?x=1", "", 1, "m")["x-hub-signature"]).not.toBe(base)
    expect(signRequest("s", "c", "GET", "/p?x=1", "b", 1, "n")["x-hub-signature"]).not.toBe(base)
    expect(signRequest("t", "c", "GET", "/p?x=1", "", 1, "n")["x-hub-signature"]).not.toBe(base)
  })
})

function client(respond: (url: string, init: any) => { status: number; body?: unknown; headers?: Record<string, string> }) {
  const calls: { url: string; init: any }[] = []
  const skews: [number, number][] = []
  const c = new HubGatewayClient({ baseUrl: "https://ra.example/", clientId: "hub:skippy-4", secretEnv: "K" }, {
    fetch: async (url, init) => {
      calls.push({ url, init })
      const r = respond(url, init)
      return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: { get: (n: string) => r.headers?.[n.toLowerCase()] ?? null }, text: async () => (r.body === undefined ? "" : JSON.stringify(r.body)) }
    },
    secret: (n) => (n === "K" ? "s3cret" : undefined),
    now: () => 1700000000000, nonce: () => "n0nce",
    onSkew: (a, b) => skews.push([a, b]),
    linkUrl: "https://ra.example/me/discord-link",
  })
  return { c, calls, skews }
}

describe("HubGatewayClient", () => {
  test("catalog: signed GET with the speaker in the query", async () => {
    const h = client(() => ({ status: 200, body: { version: "v1", reads: [{ name: "tickets", description: "Your tickets" }], actions: [] } }))
    const cat = await h.c.catalog(AURORA)
    expect(cat.reads[0]!.name).toBe("tickets")
    const { url, init } = h.calls[0]!
    expect(url).toBe(`https://ra.example/hub/v1/catalog?discordId=${AURORA}`)
    expect(init.method).toBe("GET")
    expect(init.headers["x-hub-signature"]).toBe(signRequest("s3cret", "hub:skippy-4", "GET", `/hub/v1/catalog?discordId=${AURORA}`, "", 1700000000000, "n0nce")["x-hub-signature"])
    expect(init.body).toBeUndefined()
  })

  test("a malformed catalog is treated as empty, not trusted", async () => {
    const h = client(() => ({ status: 200, body: { reads: "nope" } }))
    expect(await h.c.catalog(AURORA)).toEqual({ version: undefined, reads: [], actions: [] })
  })

  test("read: the model's query is encoded and capped; it cannot add or replace the identity", async () => {
    const h = client(() => ({ status: 200, body: { items: [] } }))
    await h.c.read(AURORA, "tickets", `x&discordId=999#` + "y".repeat(400), 500)
    const u = new URL(h.calls[0]!.url)
    expect(u.pathname).toBe("/hub/v1/read/tickets")
    expect(u.searchParams.getAll("discordId")).toEqual([AURORA])
    expect(u.searchParams.get("q")!.length).toBe(200)
    expect(u.searchParams.get("limit")).toBe("50")
  })

  test("read: a name that is not a plain identifier never reaches the network", async () => {
    const h = client(() => ({ status: 200, body: {} }))
    for (const bad of ["../admin", "tickets/1", "a b", ""]) {
      await expect(Promise.resolve().then(() => h.c.read(AURORA, bad))).rejects.toBeInstanceOf(GatewayError)
    }
    expect(h.calls.length).toBe(0)
  })

  test("propose and confirm: signed POST bodies carry the speaker; confirm carries the idempotency key", async () => {
    const h = client((url) => url.endsWith("/propose") ? { status: 200, body: { cardId: "c1", title: "Add a note" } } : { status: 200, body: { status: "done", message: "Note added" } })
    const p = await h.c.propose(AURORA, { kind: "ticket.note.add", target: { type: "ticket", id: "123" }, payload: { body: "x" }, surface: { kind: "discord", channelId: "100000", isDM: false } })
    expect(p.cardId).toBe("c1")
    expect(JSON.parse(h.calls[0]!.init.body)).toEqual({ discordId: AURORA, kind: "ticket.note.add", target: { type: "ticket", id: "123" }, payload: { body: "x" }, surface: { kind: "discord", channelId: "100000", isDM: false } })
    const r = await h.c.confirm(AURORA, "c1", "prop-9", { body: "edited" })
    expect(r.status).toBe("done")
    expect(h.calls[1]!.url).toBe("https://ra.example/hub/v1/actions/c1/confirm")
    expect(h.calls[1]!.init.headers["idempotency-key"]).toBe("prop-9")
    expect(JSON.parse(h.calls[1]!.init.body)).toEqual({ discordId: AURORA, edits: { body: "edited" } })
    expect(h.calls[1]!.init.headers["x-hub-signature"]).toBe(signRequest("s3cret", "hub:skippy-4", "POST", "/hub/v1/actions/c1/confirm", h.calls[1]!.init.body, 1700000000000, "n0nce")["x-hub-signature"])
  })

  test("a refusal becomes a GatewayError with a sentence for the person", async () => {
    const h = client(() => ({ status: 404, body: { error: "not_linked" } }))
    const e = await h.c.catalog(AURORA).catch(x => x)
    expect(e).toBeInstanceOf(GatewayError)
    expect(e.code).toBe("not_linked")
    expect(e.message).toContain("https://ra.example/me/discord-link")
  })

  test("ReadyApp's own message is shown when it sends one, and retryAfter is kept", async () => {
    const h = client(() => ({ status: 429, body: { error: "throttled", message: "10 sends an hour reached. Try again at 14:00.", retryAfterSeconds: 900 } }))
    const e = await h.c.propose(AURORA, { kind: "x", payload: {}, surface: { kind: "discord", channelId: "1", isDM: true } }).catch(x => x)
    expect(e.message).toBe("10 sends an hour reached. Try again at 14:00.")
    expect(e.retryAfterSeconds).toBe(900)
  })

  test("a stale-timestamp rejection reports both clocks", async () => {
    const h = client(() => ({ status: 401, body: { error: "stale" }, headers: { "x-server-time": "1700000090000" } }))
    const e = await h.c.catalog(AURORA).catch(x => x)
    expect(e.message).toContain("couldn't sign in to ReadyApp")
    expect(h.skews).toEqual([[1700000000000, 1700000090000]])
  })

  test("no secret configured: fails before any request", async () => {
    const calls: unknown[] = []
    const c = new HubGatewayClient({ baseUrl: "https://ra.example", clientId: "c", secretEnv: "MISSING" }, { fetch: async () => { calls.push(1); return { ok: true, status: 200, text: async () => "{}" } }, secret: () => undefined })
    const e = await c.catalog(AURORA).catch(x => x)
    expect(e.code).toBe("no_secret")
    expect(calls.length).toBe(0)
  })

  test("a network failure is a timeout error, not a crash", async () => {
    const c = new HubGatewayClient({ baseUrl: "https://ra.example", clientId: "c", secretEnv: "K" }, { fetch: async () => { throw new Error("aborted") }, secret: () => "s" })
    expect((await c.catalog(AURORA).catch(x => x)).code).toBe("timeout")
  })
})

describe("explain", () => {
  test("identity errors always use the hub's wording, never an upstream message", () => {
    expect(explain("hub_disabled", 403, "internal detail")).toContain("isn't switched on for you")
    expect(explain("inactive", 403)).toContain("isn't active")
  })
  test("server errors say nothing was changed; unknown codes are shown", () => {
    expect(explain("", 502)).toContain("Nothing was changed")
    expect(explain("weird", 418)).toContain("weird")
  })
})

test("renderCatalog lists reads and actions with their fields", () => {
  const text = renderCatalog({
    reads: [{ name: "tickets", description: "Your open tickets", params: { q: "search text" } }],
    actions: [
      { kind: "ticket.note.add", description: "Add an internal note", targetType: "ticket",
        schema: { type: "object", properties: { body: { type: "string" } }, required: ["body"] } },
      { kind: "ticket.reply", description: "Reply to the customer", targetType: "ticket", external: true, schema: { properties: { text: { type: "string" } }, required: ["text"] } },
      { kind: "reminder.create", description: "Set a reminder", targetType: "self", schema: { properties: { dueAt: { type: "string" }, text: { type: "string" } }, required: ["dueAt"] } },
    ],
  })
  expect(text).toContain("- tickets: Your open tickets (optional: q = search text)")
  expect(text).toContain("- ticket.note.add: Add an internal note [target: a ticket id] {body* (string)}")
  expect(text).toContain("[goes outside Player Ready]")
  expect(text).toContain("- reminder.create: Set a reminder {dueAt* (string), text (string)}")
  expect(renderCatalog({ reads: [], actions: [] })).toContain("- none")
})

describe("the real contract", () => {
  test("successes are unwrapped from ReadyApp's { data } envelope", async () => {
    const h = client(() => ({ status: 200, body: { data: { version: "2026-11-18.1", reads: [{ name: "resolve", description: "Find a record" }], actions: [] } } }))
    expect((await h.c.catalog(AURORA)).reads[0]!.name).toBe("resolve")
  })
  test("cancel carries an idempotency key; status is a signed GET with the speaker", async () => {
    const h = client((url) => ({ status: 200, body: { data: url.includes("cancel") ? { status: "cancelled" } : { cardId: "c1", status: "done", message: "ok" } } }))
    await h.c.cancel(AURORA, "c1", "k-1")
    expect(h.calls[0]!.init.headers["idempotency-key"]).toBe("k-1")
    expect((await h.c.status(AURORA, "c1")).status).toBe("done")
    expect(h.calls[1]!.url).toBe(`https://ra.example/hub/v1/actions/c1?discordId=${AURORA}`)
  })
  test("stale_timestamp and replayed_nonce read as a sign-in problem", () => {
    expect(explain("stale_timestamp", 401)).toContain("couldn't sign in")
    expect(explain("replayed_nonce", 401)).toContain("couldn't sign in")
  })
  test("targetTypes are listed", () => {
    expect(renderCatalog({ reads: [], actions: [{ kind: "x", description: "d", targetTypes: ["ticket", "deal"] }] })).toContain("[target: a ticket or deal id]")
  })
})

describe("detail reads and filters", () => {
  test("id goes in the path, filters in the query; identity, q and limit cannot be overridden", async () => {
    const h = client(() => ({ status: 200, body: { data: {} } }))
    await h.c.read(AURORA, "tickets", "x", undefined, { id: "4553", params: { status: "open", summary: true, discordId: "999", q: "evil", limit: 5, "bad key": "v", nested: { a: 1 } } })
    const u = new URL(h.calls[0]!.url)
    expect(u.pathname).toBe("/hub/v1/read/tickets/4553")
    expect(u.searchParams.getAll("discordId")).toEqual([AURORA])
    expect(u.searchParams.getAll("q")).toEqual(["x"])
    expect(u.searchParams.get("limit")).toBe("5")
    expect(u.searchParams.get("status")).toBe("open")
    expect(u.searchParams.get("summary")).toBe("true")
    expect([...u.searchParams.keys()].sort()).toEqual(["discordId", "limit", "q", "status", "summary"])
  })
  test("reply context is a fixed path for one ticket, with only the identity in the query", async () => {
    const h = client(() => ({ status: 200, body: { data: {} } }))
    await h.c.read(AURORA, "tickets", "ignored", undefined, { id: "4553", params: { view: "reply-context", status: "open" } })
    const u = new URL(h.calls[0]!.url)
    expect(u.pathname).toBe("/hub/v1/read/tickets/4553/reply-context")
    expect([...u.searchParams.keys()]).toEqual(["discordId"])
    await expect(Promise.resolve().then(() => h.c.read(AURORA, "deals", undefined, undefined, { id: "1", params: { view: "reply-context" } }))).rejects.toBeInstanceOf(GatewayError)
    await expect(Promise.resolve().then(() => h.c.read(AURORA, "tickets", undefined, undefined, { params: { view: "reply-context" } }))).rejects.toBeInstanceOf(GatewayError)
    expect(h.calls.length).toBe(1)
  })
  test("an id that is not a plain token never reaches the network", async () => {
    const h = client(() => ({ status: 200, body: {} }))
    for (const bad of ["../x", "1/2", "a b", ""]) await expect(Promise.resolve().then(() => h.c.read(AURORA, "tickets", undefined, undefined, { id: bad }))).rejects.toBeInstanceOf(GatewayError)
    expect(h.calls.length).toBe(0)
  })
})
