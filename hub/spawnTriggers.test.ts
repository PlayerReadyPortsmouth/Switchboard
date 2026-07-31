import { describe, expect, it } from "bun:test";
import { compileSpawnTriggers, matchSpawnTrigger } from "./spawnTriggers";

const base = {
  pattern: "^SPAWN_GLITCHTIP_FIX\\s+([a-z0-9]{20,32})$",
  sourceAgent: "prod-sentinel",
  agent: "fix",
  taskTemplate: "Fix card $1",
};

describe("matchSpawnTrigger", () => {
  it("matches an anchored trigger from its configured source", () => {
    const match = matchSpawnTrigger(
      compileSpawnTriggers([base]),
      "prod-sentinel",
      "SPAWN_GLITCHTIP_FIX cms89w0kj0xli6cwu1oli8lu9",
    );
    expect(match?.groups[1]).toBe("cms89w0kj0xli6cwu1oli8lu9");
  });

  it("rejects the same text from every other agent", () => {
    expect(matchSpawnTrigger(
      compileSpawnTriggers([base]),
      "triage",
      "SPAWN_GLITCHTIP_FIX cms89w0kj0xli6cwu1oli8lu9",
    )).toBeNull();
  });

  it("preserves legacy unrestricted trigger behavior", () => {
    const unrestricted = { ...base, sourceAgent: undefined };
    expect(matchSpawnTrigger(
      compileSpawnTriggers([unrestricted]),
      "any-agent",
      "SPAWN_GLITCHTIP_FIX cms89w0kj0xli6cwu1oli8lu9",
    )?.trigger.agent).toBe("fix");
  });

  it("fails closed when a source restriction is present but empty", () => {
    const malformed = { ...base, sourceAgent: "" };
    expect(matchSpawnTrigger(
      compileSpawnTriggers([malformed]),
      "any-agent",
      "SPAWN_GLITCHTIP_FIX cms89w0kj0xli6cwu1oli8lu9",
    )).toBeNull();
  });

  it("does not match extra prose around an anchored command", () => {
    expect(matchSpawnTrigger(
      compileSpawnTriggers([base]),
      "prod-sentinel",
      "Please run SPAWN_GLITCHTIP_FIX cms89w0kj0xli6cwu1oli8lu9 now",
    )).toBeNull();
  });
});
