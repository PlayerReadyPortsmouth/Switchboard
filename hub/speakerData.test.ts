import { describe, expect, test } from "bun:test"
import { runSpeakerData, soleSpeaker, toolsFor, type SpeakerDataConfig } from "./speakerData"

const AURORA = "186188409499418628"
const STEPHEN = "425368343789305865"

const cfg: SpeakerDataConfig = {
  enabled: true, baseUrl: "https://prime.example/", secretEnv: "HUB_DATA_KEY",
  tools: {
    tickets: { path: "/api/hub/my/tickets", description: "Your open tickets" },
    deals: { path: "/api/hub/my/deals", description: "Your open deals" },
  },
}

function harness(response: { ok?: boolean; status?: number; body?: string; throws?: boolean } = {}) {
  const calls: { url: string; headers: Record<string, string> }[] = []
  const audit: any[] = []
  const deps = {
    fetch: async (url: string, init: { headers: Record<string, string> }) => {
      calls.push({ url, headers: init.headers })
      if (response.throws) throw new Error("aborted")
      return { ok: response.ok ?? true, status: response.status ?? 200, text: async () => response.body ?? '{"items":[]}' }
    },
    secret: (name: string) => (name === "HUB_DATA_KEY" ? "s3cret" : undefined),
    audit: (e: any) => audit.push(e),
  }
  return { deps, calls, audit }
}

const req = (over: Partial<Parameters<typeof runSpeakerData>[2]> = {}) =>
  ({ agent: "Ted", allowed: ["tickets"], tool: "tickets", people: [{ userId: AURORA }], ...over })

describe("soleSpeaker", () => {
  test("exactly one person is accepted, however many turns they have queued", () => {
    expect(soleSpeaker([{ userId: AURORA }])).toEqual({ ok: true, userId: AURORA })
    expect(soleSpeaker([{ userId: AURORA }, { userId: AURORA }])).toEqual({ ok: true, userId: AURORA })
  })
  test("nobody, or two different people, is refused", () => {
    expect(soleSpeaker([]).ok).toBe(false)
    expect(soleSpeaker([{ userId: AURORA }, { userId: STEPHEN }]).ok).toBe(false)
  })
})

describe("toolsFor", () => {
  test("only tools that are both configured and allowed to this agent", () => {
    expect(toolsFor(cfg, ["tickets", "payroll"])).toEqual([{ name: "tickets", description: "Your open tickets" }])
    expect(toolsFor(cfg, undefined)).toEqual([])
    expect(toolsFor({ ...cfg, enabled: false }, ["tickets"])).toEqual([])
    expect(toolsFor(undefined, ["tickets"])).toEqual([])
  })
})

describe("runSpeakerData", () => {
  test("fetches for the speaker, with the hub's key, and returns the body", async () => {
    const h = harness({ body: '{"items":[{"id":1}]}' })
    expect(await runSpeakerData(cfg, h.deps, req())).toBe('{"items":[{"id":1}]}')
    const u = new URL(h.calls[0]!.url)
    expect(u.origin + u.pathname).toBe("https://prime.example/api/hub/my/tickets")
    expect(u.searchParams.get("discord_id")).toBe(AURORA)
    expect(h.calls[0]!.headers.authorization).toBe("Bearer s3cret")
    expect(h.calls[0]!.headers["x-speaker-discord-id"]).toBe(AURORA)
    expect(h.audit[0]).toMatchObject({ outcome: "ok", userId: AURORA, tool: "tickets" })
  })

  test("the model's query is passed as an opaque, length-capped search term and cannot set the identity", async () => {
    const h = harness()
    await runSpeakerData(cfg, h.deps, req({ query: `x&discord_id=${STEPHEN}#` + "y".repeat(500) }))
    const u = new URL(h.calls[0]!.url)
    expect(u.searchParams.getAll("discord_id")).toEqual([AURORA])
    expect(u.searchParams.get("q")!.length).toBe(200)
    expect(u.searchParams.get("q")!.startsWith(`x&discord_id=${STEPHEN}#`)).toBe(true)
  })

  test("a tool the agent is not allowed is refused without any request, even if the hub has it", async () => {
    const h = harness()
    const out = await runSpeakerData(cfg, h.deps, req({ tool: "deals" }))
    expect(out).toContain('"deals" is not a data tool you have')
    expect(out).toContain("tickets")
    expect(h.calls.length).toBe(0)
  })

  test("an unknown tool name is refused without any request", async () => {
    const h = harness()
    expect(await runSpeakerData(cfg, h.deps, req({ allowed: ["tickets", "../admin"], tool: "../admin" }))).toContain("not a data tool")
    expect(h.calls.length).toBe(0)
  })

  test("no person behind the turn: refused, no request", async () => {
    const h = harness()
    expect(await runSpeakerData(cfg, h.deps, req({ people: [] }))).toContain("no person behind this turn")
    expect(h.calls.length).toBe(0)
    expect(h.audit[0]).toMatchObject({ outcome: "deny" })
  })

  test("two people behind the turn: refused, no request", async () => {
    const h = harness()
    expect(await runSpeakerData(cfg, h.deps, req({ people: [{ userId: AURORA }, { userId: STEPHEN }] }))).toContain("more than one person")
    expect(h.calls.length).toBe(0)
  })

  test("no key configured: says so, no request", async () => {
    const h = harness()
    expect(await runSpeakerData({ ...cfg, secretEnv: "MISSING" }, h.deps, req())).toContain("no key")
    expect(h.calls.length).toBe(0)
  })

  test("upstream 404 means the person is not known as staff", async () => {
    const h = harness({ ok: false, status: 404 })
    expect(await runSpeakerData(cfg, h.deps, req())).toContain("does not recognise")
  })

  test("upstream error and timeout tell the agent not to guess", async () => {
    expect(await runSpeakerData(cfg, harness({ ok: false, status: 500 }).deps, req())).toContain("answered 500")
    expect(await runSpeakerData(cfg, harness({ throws: true }).deps, req())).toContain("did not answer in time")
  })

  test("a long response is cut with a note", async () => {
    const h = harness({ body: "z".repeat(300) })
    const out = await runSpeakerData({ ...cfg, maxChars: 100 }, h.deps, req())
    expect(out.startsWith("z".repeat(100) + "\n(cut:")).toBe(true)
    expect(out).toContain("300 characters")
  })
})
