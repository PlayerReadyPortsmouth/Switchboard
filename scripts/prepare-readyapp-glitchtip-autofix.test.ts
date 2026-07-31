import { describe, expect, it } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prepareAgentsConfig,
  prepareHubConfig,
} from "./prepare-readyapp-glitchtip-autofix";

const PROD_SENTINEL_SUFFIX = `## GlitchTip auto-fix handoff
The signed PROD_ERROR JSON includes autofixHandoff. Card creation and dedup always happen first. Never consult triage for a recurrence, an activation-smoke message, a failed card write, a missing task id, or unless autofixHandoff is exactly true. For an eligible NEW card, call ask_agent with agent "triage" and message \`GLITCHTIP_CANDIDATE <json>\` containing taskId, title, description, severity, signature, release, route, and suspectedCause. Accept only an exact \`SPAWN_GLITCHTIP_FIX <same-taskId>\`, \`SPAWN_GLITCHTIP_FIX_QUICK <same-taskId>\`, or \`NO_GLITCHTIP_FIX <reason>\` reply. Re-emit an accepted SPAWN line exactly and with no other text. Every error, timeout, different id, or malformed answer means no spawn; leave the Bug-board card for humans.`;

const TRIAGE_SUFFIX = `## GlitchTip candidate consults
On \`GLITCHTIP_CANDIDATE <json>\`, act only as a classifier. Read the named task from the ReadyAPP Bug fixes board and inspect current code/history. Never call feedback ticket stage/action endpoints and never use card tools in this consult. Return exactly one line: \`SPAWN_GLITCHTIP_FIX_QUICK <taskId>\` for a clear single-file low-risk change; \`SPAWN_GLITCHTIP_FIX <taskId>\` for complex, risky, multi-file, auth/data/money/safeguarding, or uncertain work; or \`NO_GLITCHTIP_FIX <reason>\` for smoke events, duplicates, upstream-only outages, insufficient evidence, feature requests, or non-code incidents. Echo only the supplied taskId.`;

const FIX_SUFFIX = `## Monitoring-card mode
When the task starts \`Fix ReadyApp GlitchTip monitoring card\`, the identifier is a ReadyAPP Bug fixes board task, not a feedback ticket. Read it from board cmqdu2yui0000qybb4x2uyhwp using READYAPP_DATAOPS_MCP_TOKEN. Do not call \`/tickets/*\` or \`/feedback-actions/*\`. Add concise progress and final PR comments to the task. Use the task id as the Discord correlation_id. Otherwise follow the existing worktree, failing-test-first, scoped verification, assumptions, PR, feedback, and Aurora approval flow exactly. Never merge or deploy yourself.`;

const GLITCHTIP_QUICK_TRIGGER = {
  pattern: "^SPAWN_GLITCHTIP_FIX_QUICK\\s+([a-z0-9]{20,32})$",
  sourceAgent: "prod-sentinel",
  agent: "fix-quick",
  taskTemplate:
    "Fix ReadyApp GlitchTip monitoring card $1. The Discord correlation_id is $1. Your job id is $jobId. A fresh ReadyApp worktree off live is at /srv/switchboard/worktrees/$jobId. Read task $1 from board cmqdu2yui0000qybb4x2uyhwp and use monitoring-card mode.",
  setupCommand: "/srv/ready-switchboard/scripts/make-fix-worktree.sh $jobId",
  teardownCommand: "/srv/ready-switchboard/scripts/remove-fix-worktree.sh $jobId",
  onSpawnCard: {
    correlationId: "$1",
    title: "⚡ Working on monitoring card $1",
    body: "GlitchTip fix agent dispatched (job $jobId, fast path). It will stop at a PR approval card.",
    buttons: [
      {
        customId: "fix:cancel:$jobId",
        label: "Cancel",
        style: "danger",
        emoji: "✖️",
      },
    ],
  },
};

const GLITCHTIP_FIX_TRIGGER = {
  pattern: "^SPAWN_GLITCHTIP_FIX\\s+([a-z0-9]{20,32})$",
  sourceAgent: "prod-sentinel",
  agent: "fix",
  taskTemplate:
    "Fix ReadyApp GlitchTip monitoring card $1. The Discord correlation_id is $1. Your job id is $jobId. A fresh ReadyApp worktree off live is at /srv/switchboard/worktrees/$jobId. Read task $1 from board cmqdu2yui0000qybb4x2uyhwp and use monitoring-card mode.",
  setupCommand: "/srv/ready-switchboard/scripts/make-fix-worktree.sh $jobId",
  teardownCommand: "/srv/ready-switchboard/scripts/remove-fix-worktree.sh $jobId",
  onSpawnCard: {
    correlationId: "$1",
    title: "🔧 Working on monitoring card $1",
    body: "GlitchTip fix agent dispatched (job $jobId). It will stop at a PR approval card.",
    buttons: [
      {
        customId: "fix:cancel:$jobId",
        label: "Cancel",
        style: "danger",
        emoji: "✖️",
      },
    ],
  },
};

const agentFixture = {
  triage: {
    access: { consultableBy: ["dev-agent"] },
    runtime: { appendSystemPrompt: "existing triage prompt" },
  },
  "prod-sentinel": {
    access: {},
    runtime: { appendSystemPrompt: "existing sentinel prompt" },
  },
  fix: {
    access: {},
    runtime: { appendSystemPrompt: "existing fix prompt" },
  },
  "fix-quick": {
    access: {},
    runtime: { appendSystemPrompt: "existing quick prompt" },
  },
};

const hubFixture = {
  spawnTriggers: [
    {
      pattern: "SPAWN_FIX_QUICK\\s+(\\S+)",
      agent: "fix-quick",
      taskTemplate: "Fix $1",
    },
    {
      pattern: "SPAWN_FIX\\s+(\\S+)",
      agent: "fix",
      taskTemplate: "Fix $1",
    },
  ],
};

describe("prepareAgentsConfig", () => {
  it("adds permissions and prompt contracts without deleting existing text", () => {
    const prepared = prepareAgentsConfig(agentFixture) as typeof agentFixture;

    expect(prepared.triage.access.consultableBy).toEqual([
      "dev-agent",
      "prod-sentinel",
    ]);
    expect(prepared.triage.runtime.appendSystemPrompt).toStartWith(
      "existing triage prompt",
    );
    expect(prepared.triage.runtime.appendSystemPrompt).toBe(
      `existing triage prompt\n\n${TRIAGE_SUFFIX}`,
    );
    expect(prepared["prod-sentinel"].runtime.appendSystemPrompt).toBe(
      `existing sentinel prompt\n\n${PROD_SENTINEL_SUFFIX}`,
    );
    expect(prepared.fix.runtime.appendSystemPrompt).toBe(
      `existing fix prompt\n\n${FIX_SUFFIX}`,
    );
    expect(prepared["fix-quick"].runtime.appendSystemPrompt).toBe(
      `existing quick prompt\n\n${FIX_SUFFIX}`,
    );
  });

  it("is idempotent without mutating the caller's configuration", () => {
    const once = prepareAgentsConfig(agentFixture);

    expect(prepareAgentsConfig(once)).toEqual(once);
    expect(agentFixture.triage.access.consultableBy).toEqual(["dev-agent"]);
    expect(agentFixture.triage.runtime.appendSystemPrompt).toBe(
      "existing triage prompt",
    );
  });

  it("rejects each missing required agent", () => {
    for (const id of ["triage", "prod-sentinel", "fix", "fix-quick"]) {
      const invalid = structuredClone(agentFixture) as Record<string, unknown>;
      delete invalid[id];

      expect(() => prepareAgentsConfig(invalid)).toThrow(
        `missing required agent ${id}`,
      );
    }
  });
});

describe("prepareHubConfig", () => {
  it("source-restricts feedback triggers and adds GlitchTip triggers", () => {
    const prepared = prepareHubConfig(hubFixture) as {
      spawnTriggers: Array<{ pattern: string; sourceAgent?: string }>;
    };

    expect(
      prepared.spawnTriggers.find(
        (trigger) => trigger.pattern === "SPAWN_FIX\\s+(\\S+)",
      )?.sourceAgent,
    ).toBe("triage");
    expect(
      prepared.spawnTriggers.find((trigger) =>
        trigger.pattern.includes("SPAWN_GLITCHTIP_FIX"),
      )?.sourceAgent,
    ).toBe("prod-sentinel");
    expect(prepared.spawnTriggers.slice(-2)).toEqual([
      GLITCHTIP_QUICK_TRIGGER,
      GLITCHTIP_FIX_TRIGGER,
    ]);
  });

  it("is idempotent without mutating the caller's configuration", () => {
    const once = prepareHubConfig(hubFixture);

    expect(prepareHubConfig(once)).toEqual(once);
    expect(hubFixture.spawnTriggers[0]).not.toHaveProperty("sourceAgent");
  });
});

type CliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

function runCli(configDir: string, ...args: string[]): CliResult {
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "run",
      join(import.meta.dir, "prepare-readyapp-glitchtip-autofix.ts"),
      "--config-dir",
      configDir,
      ...args,
    ],
    cwd: join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function withConfigDir(
  test: (config: {
    dir: string;
    agentsPath: string;
    hubPath: string;
    agentsText: string;
    hubText: string;
  }) => void,
): void {
  const dir = mkdtempSync(join(tmpdir(), "switchboard-glitchtip-preparer-"));
  const agentsPath = join(dir, "agents.json");
  const hubPath = join(dir, "hub.config.json");
  const agentsText = JSON.stringify(agentFixture);
  const hubText = JSON.stringify(hubFixture);
  writeFileSync(agentsPath, agentsText);
  writeFileSync(hubPath, hubText);
  try {
    test({ dir, agentsPath, hubPath, agentsText, hubText });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("preparer CLI", () => {
  it("checks both files and prints a structural summary without writing", () => {
    withConfigDir(({ dir, agentsPath, hubPath, agentsText, hubText }) => {
      const before = readdirSync(dir).sort();
      const result = runCli(dir, "--check");

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        mode: "check",
        agents: {
          triageConsultableByProdSentinel: true,
          promptContracts: 4,
        },
        spawnTriggers: {
          feedbackSourceRestricted: 2,
          glitchtipSourceRestricted: 2,
        },
      });
      expect(result.stderr).toBe("");
      expect(readFileSync(agentsPath, "utf8")).toBe(agentsText);
      expect(readFileSync(hubPath, "utf8")).toBe(hubText);
      expect(readdirSync(dir).sort()).toEqual(before);
    });
  });

  it("applies atomically with backups, preserves modes, and is byte-idempotent", () => {
    withConfigDir(({ dir, agentsPath, hubPath, agentsText, hubText }) => {
      chmodSync(agentsPath, 0o640);
      chmodSync(hubPath, 0o600);
      const agentMode = statSync(agentsPath).mode & 0o777;
      const hubMode = statSync(hubPath).mode & 0o777;

      const first = runCli(dir, "--apply");
      expect(first.exitCode).toBe(0);
      expect(JSON.parse(first.stdout).mode).toBe("apply");
      expect(first.stderr).toBe("");

      const agentOnce = readFileSync(agentsPath, "utf8");
      const hubOnce = readFileSync(hubPath, "utf8");
      expect(() => JSON.parse(agentOnce)).not.toThrow();
      expect(() => JSON.parse(hubOnce)).not.toThrow();
      expect(statSync(agentsPath).mode & 0o777).toBe(agentMode);
      expect(statSync(hubPath).mode & 0o777).toBe(hubMode);

      const firstFiles = readdirSync(dir);
      const agentBackup = firstFiles.find((name) =>
        name.startsWith("agents.json.bak-"),
      );
      const hubBackup = firstFiles.find((name) =>
        name.startsWith("hub.config.json.bak-"),
      );
      expect(agentBackup).toBeDefined();
      expect(hubBackup).toBeDefined();
      expect(readFileSync(join(dir, agentBackup!), "utf8")).toBe(agentsText);
      expect(readFileSync(join(dir, hubBackup!), "utf8")).toBe(hubText);
      expect(firstFiles.some((name) => name.includes(".tmp-"))).toBeFalse();

      const second = runCli(dir, "--apply");
      expect(second.exitCode).toBe(0);
      expect(readFileSync(agentsPath, "utf8")).toBe(agentOnce);
      expect(readFileSync(hubPath, "utf8")).toBe(hubOnce);
      expect(readdirSync(dir).some((name) => name.includes(".tmp-"))).toBeFalse();
    });
  });

  it("rejects invalid input before writing or creating backups", () => {
    for (const missingIndex of [0, 1]) {
      withConfigDir(({ dir, agentsPath, hubPath, agentsText }) => {
        const remainingTrigger = hubFixture.spawnTriggers[1 - missingIndex];
        const invalidHub = JSON.stringify({
          spawnTriggers: [remainingTrigger],
        });
        writeFileSync(hubPath, invalidHub);
        const before = readdirSync(dir).sort();

        const result = runCli(dir, "--apply");

        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain(
          `missing feedback spawn trigger ${hubFixture.spawnTriggers[missingIndex].pattern}`,
        );
        expect(readFileSync(agentsPath, "utf8")).toBe(agentsText);
        expect(readFileSync(hubPath, "utf8")).toBe(invalidHub);
        expect(readdirSync(dir).sort()).toEqual(before);
      });
    }
  });

  it("requires exactly one operation mode", () => {
    withConfigDir(({ dir }) => {
      expect(runCli(dir).exitCode).not.toBe(0);
      expect(runCli(dir, "--check", "--apply").exitCode).not.toBe(0);
    });
  });
});
