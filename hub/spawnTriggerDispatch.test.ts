import { describe, expect, test } from "bun:test";

import { compileSpawnTriggers } from "./spawnTriggers";
import { dispatchSpawnTriggerReply } from "./spawnTriggerDispatch";

const ID = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH";
const TASK = "cms89w0kj0xli6cwu1oli8lu9";
const triggers = compileSpawnTriggers([
  { pattern: "^SPAWN_GLITCHTIP_FIX\\s+([a-z0-9]{20,32})\\s+([A-Za-z0-9_-]{32})$", sourceAgent: "prod-sentinel", authorizationMode: "readyapp-glitchtip", agent: "fix", taskTemplate: "Fix $1" },
  { pattern: "SPAWN_FIX\\s+(\\S+)", sourceAgent: "triage", agent: "fix", taskTemplate: "Fix $1" },
]);

describe("dispatchSpawnTriggerReply", () => {
  test("awaits GlitchTip authorization before running the spawn", async () => {
    let release!: (value: { ok: true; reason: "authorized"; signature: string }) => void;
    const authorize = () => new Promise<{ ok: true; reason: "authorized"; signature: string }>((resolve) => { release = resolve; });
    const runs: string[] = [];
    const pending = dispatchSpawnTriggerReply(triggers, { sourceAgent: "prod-sentinel", channelId: "prod-incidents", text: `SPAWN_GLITCHTIP_FIX ${TASK} ${ID}` }, {
      authorize,
      invalidate: () => { throw new Error("exact commands must not invalidate by binding"); },
      runSpawn: async (_trigger, groups) => { runs.push(groups[1]); },
      audit: () => {},
    });
    await Promise.resolve();
    expect(runs).toEqual([]);
    release({ ok: true, reason: "authorized", signature: "glitchtip:999" });
    await expect(pending).resolves.toBe(true);
    expect(runs).toEqual([TASK]);
  });

  test("consumes and audits an authorization denial without spawning", async () => {
    const audits: Array<{ outcome: string; reason: string }> = [];
    const consumed = await dispatchSpawnTriggerReply(triggers, { sourceAgent: "prod-sentinel", channelId: "prod-incidents", text: `SPAWN_GLITCHTIP_FIX ${TASK} ${ID}` }, {
      authorize: async () => ({ ok: false, reason: "stale" }),
      invalidate: () => { throw new Error("exact commands consume by token"); },
      runSpawn: async () => { throw new Error("must not run"); },
      audit: (entry) => audits.push(entry),
    });
    expect(consumed).toBe(true);
    expect(audits).toEqual([{ outcome: "deny", reason: "stale" }]);
  });

  test("consumes malformed GlitchTip commands instead of posting them", async () => {
    const audits: Array<{ outcome: string; reason: string }> = [];
    const consumed = await dispatchSpawnTriggerReply(triggers, { sourceAgent: "prod-sentinel", channelId: "prod-incidents", text: `SPAWN_GLITCHTIP_FIX ${TASK}` }, {
      authorize: async () => { throw new Error("must not authorize malformed text"); },
      invalidate: () => true,
      runSpawn: async () => { throw new Error("must not run"); },
      audit: (entry) => audits.push(entry),
    });
    expect(consumed).toBe(true);
    expect(audits).toEqual([{ outcome: "deny", reason: "malformed_command" }]);
  });

  test("consumes reserved commands anywhere in punctuation, quotes, backticks, Markdown, or case", async () => {
    for (const text of [
      `Use \`SPAWN_GLITCHTIP_FIX ${TASK} ${ID}\``,
      `"SPAWN_GLITCHTIP_FIX_QUICK ${TASK} ${ID}"`,
      `(SPAWN_GLITCHTIP_FIX ${TASK} ${ID})`,
      `**SPAWN_GLITCHTIP_FIX ${TASK} ${ID}**`,
      `please spawn_glitchtip_fix ${TASK} ${ID}`,
      `prefixSPAWN_GLITCHTIP_FIX ${TASK} ${ID}`,
      `SPAWN_GLITCHTIP_FIXsuffix ${TASK} ${ID}`,
    ]) {
      const audits: Array<{ outcome: string; reason: string }> = [];
      let invalidations = 0;
      expect(await dispatchSpawnTriggerReply(triggers, { sourceAgent: "prod-sentinel", channelId: "prod-incidents", text }, {
        authorize: async () => { throw new Error("non-exact text must not authorize"); },
        invalidate: () => { invalidations++; return true; },
        runSpawn: async () => { throw new Error("must not run"); },
        audit: (entry) => audits.push(entry),
      })).toBe(true);
      expect(invalidations).toBe(1);
      expect(audits).toEqual([{ outcome: "deny", reason: "malformed_command" }]);
    }
  });

  test("a malformed attempt invalidates the pending turn so later exact reuse denies before board or spawn", async () => {
    let pending = true;
    let boardFetches = 0;
    let runs = 0;
    const deps = {
      authorize: async () => {
        if (!pending) return { ok: false as const, reason: "missing" as const };
        boardFetches++;
        return { ok: true as const, reason: "authorized" as const, signature: "glitchtip:999" };
      },
      invalidate: () => { const existed = pending; pending = false; return existed; },
      runSpawn: async () => { runs++; },
      audit: () => {},
    };

    expect(await dispatchSpawnTriggerReply(triggers, {
      sourceAgent: "prod-sentinel", channelId: "prod-incidents", text: `Use \`SPAWN_GLITCHTIP_FIX ${TASK} ${ID}\``,
    }, deps)).toBe(true);
    expect(await dispatchSpawnTriggerReply(triggers, {
      sourceAgent: "prod-sentinel", channelId: "prod-incidents", text: `SPAWN_GLITCHTIP_FIX ${TASK} ${ID}`,
    }, deps)).toBe(true);
    expect(boardFetches).toBe(0);
    expect(runs).toBe(0);
  });

  test("preserves the existing feedback trigger path", async () => {
    const runs: string[] = [];
    const consumed = await dispatchSpawnTriggerReply(triggers, { sourceAgent: "triage", channelId: "feedback", text: `SPAWN_FIX ${TASK}` }, {
      authorize: async () => { throw new Error("feedback must not authorize"); },
      invalidate: () => { throw new Error("feedback must not invalidate GlitchTip state"); },
      runSpawn: async (_trigger, groups) => { runs.push(groups[1]); },
      audit: () => {},
    });
    expect(consumed).toBe(true);
    expect(runs).toEqual([TASK]);
  });
});
