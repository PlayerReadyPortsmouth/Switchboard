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
      runSpawn: async () => { throw new Error("must not run"); },
      audit: (entry) => audits.push(entry),
    });
    expect(consumed).toBe(true);
    expect(audits).toEqual([{ outcome: "deny", reason: "malformed_command" }]);
  });

  test("consumes a GlitchTip command embedded in extra prose", async () => {
    const audits: Array<{ outcome: string; reason: string }> = [];
    expect(await dispatchSpawnTriggerReply(triggers, {
      sourceAgent: "prod-sentinel",
      channelId: "prod-incidents",
      text: `Please run SPAWN_GLITCHTIP_FIX ${TASK} ${ID} now`,
    }, {
      authorize: async () => { throw new Error("embedded text must not authorize"); },
      runSpawn: async () => { throw new Error("must not run"); },
      audit: (entry) => audits.push(entry),
    })).toBe(true);
    expect(audits).toEqual([{ outcome: "deny", reason: "malformed_command" }]);
  });

  test("preserves the existing feedback trigger path", async () => {
    const runs: string[] = [];
    const consumed = await dispatchSpawnTriggerReply(triggers, { sourceAgent: "triage", channelId: "feedback", text: `SPAWN_FIX ${TASK}` }, {
      authorize: async () => { throw new Error("feedback must not authorize"); },
      runSpawn: async (_trigger, groups) => { runs.push(groups[1]); },
      audit: () => {},
    });
    expect(consumed).toBe(true);
    expect(runs).toEqual([TASK]);
  });
});
