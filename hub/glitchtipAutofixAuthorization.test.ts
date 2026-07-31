import { describe, expect, test } from "bun:test";

import { GlitchtipAutofixAuthorizationRegistry } from "./glitchtipAutofixAuthorization";

const ID = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH";
const OTHER_ID = "CAgICAgICAgICAgICAgICAgICAgICAgI";
const TASK = "cms89w0kj0xli6cwu1oli8lu9";
const SIGNATURE = "glitchtip:999";
const RECEIVED = Date.parse("2026-07-31T12:00:00.000Z");

function payload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ signature: SIGNATURE, autofixHandoff: true, autofixAuthorizationId: ID, count: 1, ...overrides });
}

function boardTask(overrides: Record<string, unknown> = {}) {
  return { id: TASK, createdAt: new Date(RECEIVED + 1_000).toISOString(), labels: ["prod-sentinel", "medium"], description: `Details\nsentinel-sig:${SIGNATURE}`, ...overrides };
}

function boardFetch(task = boardTask()) {
  return async (_url: string | URL | Request, init?: RequestInit) => {
    expect(new Headers(init?.headers).get("x-mcp-token")).toBe("dataops-secret");
    return new Response(JSON.stringify({ data: { stages: [{ tasks: [task] }] } }), { status: 200, headers: { "content-type": "application/json" } });
  };
}

function registry(now = RECEIVED) {
  let clock = now;
  const value = new GlitchtipAutofixAuthorizationRegistry({ now: () => clock, ttlMs: 120_000, cardClockToleranceMs: 5_000 });
  return { value, setNow: (next: number) => { clock = next; } };
}

const binding = { agent: "prod-sentinel", channelId: "prod-incidents" };
const request = { authorizationId: ID, taskId: TASK, sourceAgent: "prod-sentinel", channelId: "prod-incidents", apiBase: "http://127.0.0.1:4000", apiToken: "dataops-secret", fetch: boardFetch() as typeof fetch };

describe("GlitchtipAutofixAuthorizationRegistry", () => {
  test("allows one matching newly-created prod-sentinel board card", async () => {
    const { value } = registry();
    expect(value.registerVerifiedBody(payload(), binding)).toBe(true);
    await expect(value.consumeAndAuthorize(request)).resolves.toEqual({ ok: true, reason: "authorized", signature: SIGNATURE });
  });

  test("does not register missing, false, recurrence, smoke, or malformed payloads", async () => {
    for (const raw of [payload({ autofixAuthorizationId: null }), payload({ autofixHandoff: false }), payload({ count: 2 }), payload({ autofixHandoff: false, autofixAuthorizationId: null, message: "ReadyApp GlitchTip activation smoke" }), "{not-json"]) {
      const { value } = registry();
      expect(value.registerVerifiedBody(raw, binding)).toBe(false);
      await expect(value.consumeAndAuthorize(request)).resolves.toMatchObject({ ok: false, reason: "missing" });
    }
  });

  test("registers only for the bound prod-sentinel webhook route", () => {
    const { value } = registry();
    expect(value.registerVerifiedBody(payload(), { agent: "triage", channelId: "prod-incidents" })).toBe(false);
    expect(value.registerVerifiedBody(payload(), { agent: "prod-sentinel", channelId: "" })).toBe(false);
  });

  test("consumes and denies stale, wrong-agent, wrong-channel, and wrong-token attempts", async () => {
    const cases = [
      { patch: {}, advance: 120_001, reason: "stale" },
      { patch: { sourceAgent: "triage" }, advance: 0, reason: "wrong_agent" },
      { patch: { channelId: "other-channel" }, advance: 0, reason: "wrong_channel" },
      { patch: { authorizationId: OTHER_ID }, advance: 0, reason: "missing" },
    ];
    for (const c of cases) {
      const { value, setNow } = registry();
      expect(value.registerVerifiedBody(payload(), binding)).toBe(true);
      setNow(RECEIVED + c.advance);
      await expect(value.consumeAndAuthorize({ ...request, ...c.patch })).resolves.toMatchObject({ ok: false, reason: c.reason });
    }
  });

  test("a token is one-shot even after a successful authorization", async () => {
    const { value } = registry();
    value.registerVerifiedBody(payload(), binding);
    expect((await value.consumeAndAuthorize(request)).ok).toBe(true);
    await expect(value.consumeAndAuthorize(request)).resolves.toMatchObject({ ok: false, reason: "missing" });
  });

  test("a wrong token attempt invalidates the pending authorization for that agent channel", async () => {
    const { value } = registry();
    value.registerVerifiedBody(payload(), binding);
    await expect(value.consumeAndAuthorize({ ...request, authorizationId: OTHER_ID })).resolves.toMatchObject({ ok: false, reason: "missing" });
    await expect(value.consumeAndAuthorize(request)).resolves.toMatchObject({ ok: false, reason: "missing" });
  });

  test("a duplicate verified payload invalidates rather than refreshes a token", async () => {
    const { value } = registry();
    expect(value.registerVerifiedBody(payload(), binding)).toBe(true);
    expect(value.registerVerifiedBody(payload(), binding)).toBe(false);
    await expect(value.consumeAndAuthorize(request)).resolves.toMatchObject({ ok: false, reason: "missing" });
  });

  test("consumes and denies task mismatch, old cards, missing label, and signature mismatch", async () => {
    const cases = [
      { taskId: "cms89w0kj0xli6cwu1oli8lu8", task: boardTask(), reason: "task_missing" },
      { taskId: TASK, task: boardTask({ createdAt: new Date(RECEIVED - 5_001).toISOString() }), reason: "task_old" },
      { taskId: TASK, task: boardTask({ labels: ["medium"] }), reason: "label_missing" },
      { taskId: TASK, task: boardTask({ description: "sentinel-sig:other" }), reason: "signature_mismatch" },
    ];
    for (const c of cases) {
      const { value } = registry();
      value.registerVerifiedBody(payload(), binding);
      await expect(value.consumeAndAuthorize({ ...request, taskId: c.taskId, fetch: boardFetch(c.task) as typeof fetch })).resolves.toMatchObject({ ok: false, reason: c.reason });
    }
  });

  test("ignores unrelated board tasks with nullable optional fields", async () => {
    const { value } = registry();
    value.registerVerifiedBody(payload(), binding);
    const fetchWithUnrelated = (async () => new Response(JSON.stringify({
      data: { stages: [{ tasks: [{ id: "other", description: null, labels: null }, boardTask()] }] },
    }), { status: 200 })) as unknown as typeof fetch;
    await expect(value.consumeAndAuthorize({ ...request, fetch: fetchWithUnrelated })).resolves.toMatchObject({ ok: true });
  });

  test("consumes and denies missing API credentials and board fetch failures", async () => {
    const cases = [
      { apiToken: "", fetch: boardFetch() as typeof fetch, reason: "credentials_missing" },
      { apiToken: "dataops-secret", fetch: (async () => { throw new Error("down"); }) as unknown as typeof fetch, reason: "board_fetch_failed" },
      { apiToken: "dataops-secret", fetch: (async () => new Response("no", { status: 503 })) as unknown as typeof fetch, reason: "board_fetch_failed" },
    ];
    for (const c of cases) {
      const { value } = registry();
      value.registerVerifiedBody(payload(), binding);
      await expect(value.consumeAndAuthorize({ ...request, ...c })).resolves.toMatchObject({ ok: false, reason: c.reason });
    }
  });
});
