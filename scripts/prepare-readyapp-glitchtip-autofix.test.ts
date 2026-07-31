import { describe, expect, it } from "bun:test";
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  type PreparerIo,
  prepareAgentsConfig,
  prepareConfigDirectory,
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

  it("rejects partial and duplicate prompt contracts for every target agent", () => {
    const contracts = [
      {
        id: "prod-sentinel",
        marker: "## GlitchTip auto-fix handoff",
        suffix: PROD_SENTINEL_SUFFIX,
      },
      {
        id: "triage",
        marker: "## GlitchTip candidate consults",
        suffix: TRIAGE_SUFFIX,
      },
      { id: "fix", marker: "## Monitoring-card mode", suffix: FIX_SUFFIX },
      {
        id: "fix-quick",
        marker: "## Monitoring-card mode",
        suffix: FIX_SUFFIX,
      },
    ];

    for (const { id, marker, suffix } of contracts) {
      const partial = structuredClone(agentFixture) as Record<string, any>;
      partial[id].runtime.appendSystemPrompt = `existing\n\n${marker}\nSTALE`;
      expect(() => prepareAgentsConfig(partial)).toThrow(
        `prompt for ${id} has a partial or duplicate ${marker} contract`,
      );

      const duplicate = structuredClone(agentFixture) as Record<string, any>;
      duplicate[id].runtime.appendSystemPrompt = `existing\n\n${suffix}\n\n${suffix}`;
      expect(() => prepareAgentsConfig(duplicate)).toThrow(
        `prompt for ${id} has a partial or duplicate ${marker} contract`,
      );
    }
  });

  it("rejects malformed agent containers and prompt fields", () => {
    const malformedAccess = structuredClone(agentFixture) as Record<string, any>;
    malformedAccess.triage.access = [];
    expect(() => prepareAgentsConfig(malformedAccess)).toThrow(
      "agent triage access must be an object",
    );

    const malformedRuntime = structuredClone(agentFixture) as Record<string, any>;
    malformedRuntime.fix.runtime = [];
    expect(() => prepareAgentsConfig(malformedRuntime)).toThrow(
      "agent fix runtime must be an object",
    );

    const malformedAllowlist = structuredClone(agentFixture) as Record<string, any>;
    malformedAllowlist.triage.access.consultableBy = "prod-sentinel";
    expect(() => prepareAgentsConfig(malformedAllowlist)).toThrow(
      "agent triage access.consultableBy must be an array of strings",
    );

    const malformedPrompt = structuredClone(agentFixture) as Record<string, any>;
    malformedPrompt["prod-sentinel"].runtime.appendSystemPrompt = 42;
    expect(() => prepareAgentsConfig(malformedPrompt)).toThrow(
      "agent prod-sentinel runtime.appendSystemPrompt must be a string",
    );
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

  it("requires unique feedback patterns with their expected agent mappings", () => {
    const duplicate = structuredClone(hubFixture);
    duplicate.spawnTriggers.push(structuredClone(hubFixture.spawnTriggers[1]));
    expect(() => prepareHubConfig(duplicate)).toThrow(
      "feedback spawn trigger SPAWN_FIX\\s+(\\S+) must occur exactly once",
    );

    const wrongAgent = structuredClone(hubFixture);
    wrongAgent.spawnTriggers[0].agent = "fix";
    expect(() => prepareHubConfig(wrongAgent)).toThrow(
      "feedback spawn trigger SPAWN_FIX_QUICK\\s+(\\S+) must target fix-quick",
    );
  });

  it("preserves unrelated feedback trigger fields while restricting the source", () => {
    const input = structuredClone(hubFixture);
    Object.assign(input.spawnTriggers[0], {
      taskTemplate: "Keep this exact template $1",
      setupCommand: "keep-setup",
      onSpawnCard: { title: "keep-card" },
    });

    const prepared = prepareHubConfig(input) as typeof input & {
      spawnTriggers: Array<(typeof input.spawnTriggers)[number] & {
        sourceAgent?: string;
      }>;
    };

    expect(prepared.spawnTriggers[0]).toEqual({
      ...input.spawnTriggers[0],
      sourceAgent: "triage",
    });
  });

  it("requires an existing GlitchTip trigger to be unique and exactly safe", () => {
    const unsafe = structuredClone(hubFixture) as {
      spawnTriggers: Array<Record<string, unknown>>;
    };
    unsafe.spawnTriggers.push({
      ...GLITCHTIP_FIX_TRIGGER,
      agent: "shell",
    });
    expect(() => prepareHubConfig(unsafe)).toThrow(
      "GlitchTip spawn trigger ^SPAWN_GLITCHTIP_FIX\\s+([a-z0-9]{20,32})$ does not match the required contract",
    );

    const duplicate = structuredClone(hubFixture) as {
      spawnTriggers: Array<Record<string, unknown>>;
    };
    duplicate.spawnTriggers.push(
      structuredClone(GLITCHTIP_FIX_TRIGGER),
      structuredClone(GLITCHTIP_FIX_TRIGGER),
    );
    expect(() => prepareHubConfig(duplicate)).toThrow(
      "GlitchTip spawn trigger ^SPAWN_GLITCHTIP_FIX\\s+([a-z0-9]{20,32})$ must occur at most once",
    );
  });

  it("retains one exact existing GlitchTip trigger without duplication", () => {
    const input = structuredClone(hubFixture) as {
      spawnTriggers: Array<Record<string, unknown>>;
    };
    input.spawnTriggers.push(structuredClone(GLITCHTIP_FIX_TRIGGER));

    const prepared = prepareHubConfig(input) as {
      spawnTriggers: Array<Record<string, unknown>>;
    };

    expect(
      prepared.spawnTriggers.filter(
        (trigger) => trigger.pattern === GLITCHTIP_FIX_TRIGGER.pattern,
      ),
    ).toEqual([GLITCHTIP_FIX_TRIGGER]);
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

function nodePreparerIo(overrides: Partial<PreparerIo> = {}): PreparerIo {
  return {
    readText: (path) => readFileSync(path, "utf8"),
    fileMode: (path) => statSync(path).mode & 0o777,
    copyExclusive: (source, destination) =>
      copyFileSync(source, destination, constants.COPYFILE_EXCL),
    writeExclusive: (path, contents, mode) =>
      writeFileSync(path, contents, {
        encoding: "utf8",
        mode,
        flag: "wx",
      }),
    chmod: (path, mode) => chmodSync(path, mode),
    rename: (source, destination) => renameSync(source, destination),
    exists: (path) => existsSync(path),
    unlink: (path) => unlinkSync(path),
    ...overrides,
  };
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
          promptContractsExact: true,
        },
        spawnTriggers: {
          feedbackSourceRestricted: 2,
          glitchtipSourceRestricted: 2,
          feedbackContractsExact: true,
          glitchtipContractsExact: true,
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
      const firstOutput = JSON.parse(first.stdout);
      expect(firstOutput.mode).toBe("apply");
      expect(first.stderr).toBe("");

      const agentOnce = readFileSync(agentsPath, "utf8");
      const hubOnce = readFileSync(hubPath, "utf8");
      expect(() => JSON.parse(agentOnce)).not.toThrow();
      expect(() => JSON.parse(hubOnce)).not.toThrow();
      expect(statSync(agentsPath).mode & 0o777).toBe(agentMode);
      expect(statSync(hubPath).mode & 0o777).toBe(hubMode);

      const firstFiles = readdirSync(dir);
      const agentBackup = firstFiles.find((name) =>
        name.startsWith("agents.json.bak-glitchtip-autofix-"),
      );
      const hubBackup = firstFiles.find((name) =>
        name.startsWith("hub.config.json.bak-glitchtip-autofix-"),
      );
      expect(agentBackup).toBeDefined();
      expect(hubBackup).toBeDefined();
      expect(readFileSync(join(dir, agentBackup!), "utf8")).toBe(agentsText);
      expect(readFileSync(join(dir, hubBackup!), "utf8")).toBe(hubText);
      expect(firstOutput.backups).toEqual({
        agents: join(dir, agentBackup!),
        hub: join(dir, hubBackup!),
      });
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
          `feedback spawn trigger ${hubFixture.spawnTriggers[missingIndex].pattern} must occur exactly once`,
        );
        expect(readFileSync(agentsPath, "utf8")).toBe(agentsText);
        expect(readFileSync(hubPath, "utf8")).toBe(invalidHub);
        expect(readdirSync(dir).sort()).toEqual(before);
      });
    }

    withConfigDir(({ dir, agentsPath, hubPath, hubText }) => {
      const malformedAgents = structuredClone(agentFixture) as Record<
        string,
        any
      >;
      malformedAgents.triage.access = [];
      const malformedText = JSON.stringify(malformedAgents);
      writeFileSync(agentsPath, malformedText);

      const result = runCli(dir, "--apply");

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("agent triage access must be an object");
      expect(readFileSync(agentsPath, "utf8")).toBe(malformedText);
      expect(readFileSync(hubPath, "utf8")).toBe(hubText);
      expect(
        readdirSync(dir).some((name) =>
          name.includes(".bak-glitchtip-autofix-"),
        ),
      ).toBeFalse();
    });
  });

  it("requires exactly one operation mode", () => {
    withConfigDir(({ dir }) => {
      expect(runCli(dir).exitCode).not.toBe(0);
      expect(runCli(dir, "--check", "--apply").exitCode).not.toBe(0);
    });
  });

  it("does not rename either live file when staging the second candidate temp fails", () => {
    withConfigDir(({ dir, agentsPath, hubPath, agentsText, hubText }) => {
      let renameCount = 0;
      const baseIo = nodePreparerIo();
      const io = nodePreparerIo({
        writeExclusive: (path, contents, mode) => {
          if (
            path.includes("hub.config.json.tmp-glitchtip-autofix-") &&
            !path.includes("rollback")
          ) {
            throw new Error("injected second candidate temp failure");
          }
          baseIo.writeExclusive(path, contents, mode);
        },
        rename: (source, destination) => {
          renameCount += 1;
          baseIo.rename(source, destination);
        },
      });

      expect(() =>
        prepareConfigDirectory(dir, "apply", {
          io,
          label: "second-temp",
        }),
      ).toThrow("injected second candidate temp failure");
      expect(renameCount).toBe(0);
      expect(readFileSync(agentsPath, "utf8")).toBe(agentsText);
      expect(readFileSync(hubPath, "utf8")).toBe(hubText);
      expect(
        readdirSync(dir).filter((name) =>
          name.includes(".bak-glitchtip-autofix-"),
        ),
      ).toHaveLength(2);
      expect(
        readdirSync(dir).filter((name) =>
          name.includes(".tmp-glitchtip-autofix-"),
        ),
      ).toEqual([]);
    });
  });

  it("cleans a candidate temp created by a writeExclusive attempt that then throws", () => {
    withConfigDir(({ dir, agentsPath, hubPath, agentsText, hubText }) => {
      const collision = `${hubPath}.tmp-glitchtip-autofix-after-create`;
      writeFileSync(collision, "pre-existing collision");
      const baseIo = nodePreparerIo();
      const io = nodePreparerIo({
        writeExclusive: (path, contents, mode) => {
          baseIo.writeExclusive(path, contents, mode);
          if (
            path.includes("hub.config.json.tmp-glitchtip-autofix-after-create") &&
            !path.includes("rollback")
          ) {
            throw new Error("candidate after-create error");
          }
        },
      });

      expect(() =>
        prepareConfigDirectory(dir, "apply", {
          io,
          label: "after-create",
        }),
      ).toThrow("candidate after-create error");
      expect(readFileSync(agentsPath, "utf8")).toBe(agentsText);
      expect(readFileSync(hubPath, "utf8")).toBe(hubText);
      expect(readFileSync(collision, "utf8")).toBe("pre-existing collision");
      expect(
        readdirSync(dir).filter((name) =>
          name.includes(".tmp-glitchtip-autofix-"),
        ),
      ).toEqual([basename(collision)]);
    });
  });

  it("cleans a rollback temp created by a copyExclusive attempt that then throws", () => {
    withConfigDir(({ dir, agentsPath, hubPath, agentsText, hubText }) => {
      const collision = `${hubPath}.tmp-glitchtip-autofix-rollback-after-copy`;
      writeFileSync(collision, "pre-existing collision");
      const baseIo = nodePreparerIo();
      const io = nodePreparerIo({
        copyExclusive: (source, destination) => {
          baseIo.copyExclusive(source, destination);
          if (
            destination.includes(
              "hub.config.json.tmp-glitchtip-autofix-rollback-after-copy",
            )
          ) {
            throw new Error("rollback after-copy error");
          }
        },
      });

      expect(() =>
        prepareConfigDirectory(dir, "apply", {
          io,
          label: "after-copy",
        }),
      ).toThrow("rollback after-copy error");
      expect(readFileSync(agentsPath, "utf8")).toBe(agentsText);
      expect(readFileSync(hubPath, "utf8")).toBe(hubText);
      expect(readFileSync(collision, "utf8")).toBe("pre-existing collision");
      expect(
        readdirSync(dir).filter((name) =>
          name.includes(".tmp-glitchtip-autofix-"),
        ),
      ).toEqual([basename(collision)]);
    });
  });

  it("attempts every owned cleanup while preserving the original operation error", () => {
    withConfigDir(({ dir }) => {
      const baseIo = nodePreparerIo();
      const unlinkCalls: string[] = [];
      let failedCleanupPath: string | undefined;
      const io = nodePreparerIo({
        copyExclusive: (source, destination) => {
          if (
            destination.includes(
              "hub.config.json.tmp-glitchtip-autofix-rollback-cleanup-mask",
            )
          ) {
            throw new Error("original operation error");
          }
          baseIo.copyExclusive(source, destination);
        },
        unlink: (path) => {
          unlinkCalls.push(path);
          if (!failedCleanupPath) {
            failedCleanupPath = path;
            throw new Error("cleanup unlink error");
          }
          baseIo.unlink(path);
        },
      });

      let caught: unknown;
      try {
        prepareConfigDirectory(dir, "apply", {
          io,
          label: "cleanup-mask",
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toBe("original operation error");
      expect(
        (caught as Error & { cleanupErrors?: Error[] }).cleanupErrors?.map(
          (error) => error.message,
        ),
      ).toEqual(["cleanup unlink error"]);
      expect(unlinkCalls).toHaveLength(3);
      expect(
        readdirSync(dir).filter((name) =>
          name.includes(".tmp-glitchtip-autofix-"),
        ),
      ).toEqual([basename(failedCleanupPath!)]);
    });
  });

  it("rolls back the first live file when the second candidate rename fails", () => {
    withConfigDir(({ dir, agentsPath, hubPath, agentsText, hubText }) => {
      const baseIo = nodePreparerIo();
      const renames: Array<[string, string]> = [];
      let injected = false;
      const io = nodePreparerIo({
        rename: (source, destination) => {
          renames.push([source, destination]);
          if (
            !injected &&
            destination === hubPath &&
            source.includes(".tmp-glitchtip-autofix-") &&
            !source.includes("rollback")
          ) {
            injected = true;
            throw new Error("injected second candidate rename failure");
          }
          baseIo.rename(source, destination);
        },
      });

      expect(() =>
        prepareConfigDirectory(dir, "apply", {
          io,
          label: "second-rename",
        }),
      ).toThrow("injected second candidate rename failure");
      expect(renames.some(([, destination]) => destination === agentsPath)).toBeTrue();
      expect(readFileSync(agentsPath, "utf8")).toBe(agentsText);
      expect(readFileSync(hubPath, "utf8")).toBe(hubText);
      expect(
        readdirSync(dir).filter((name) =>
          name.includes(".bak-glitchtip-autofix-"),
        ),
      ).toHaveLength(2);
      expect(
        readdirSync(dir).filter((name) =>
          name.includes(".tmp-glitchtip-autofix-"),
        ),
      ).toEqual([]);
    });
  });

  it("semantically validates both staged candidate files before renaming", () => {
    withConfigDir(({ dir, agentsPath, hubPath, agentsText, hubText }) => {
      const baseIo = nodePreparerIo();
      let renameCount = 0;
      const io = nodePreparerIo({
        writeExclusive: (path, contents, mode) => {
          if (
            path.includes("hub.config.json.tmp-glitchtip-autofix-") &&
            !path.includes("rollback")
          ) {
            const unsafe = JSON.parse(contents);
            unsafe.spawnTriggers.find(
              (trigger: Record<string, unknown>) =>
                trigger.pattern === GLITCHTIP_FIX_TRIGGER.pattern,
            ).agent = "shell";
            baseIo.writeExclusive(
              path,
              `${JSON.stringify(unsafe, null, 2)}\n`,
              mode,
            );
            return;
          }
          baseIo.writeExclusive(path, contents, mode);
        },
        rename: (source, destination) => {
          renameCount += 1;
          baseIo.rename(source, destination);
        },
      });

      expect(() =>
        prepareConfigDirectory(dir, "apply", {
          io,
          label: "semantic-temp",
        }),
      ).toThrow("does not match the unique required contract");
      expect(renameCount).toBe(0);
      expect(readFileSync(agentsPath, "utf8")).toBe(agentsText);
      expect(readFileSync(hubPath, "utf8")).toBe(hubText);
      expect(
        readdirSync(dir).filter((name) =>
          name.includes(".tmp-glitchtip-autofix-"),
        ),
      ).toEqual([]);
    });
  });

  it("retries exclusive purpose-named backup collisions without overwriting", () => {
    withConfigDir(({ dir, agentsPath }) => {
      const collision = `${agentsPath}.bak-glitchtip-autofix-collision`;
      writeFileSync(collision, "retain me");

      const result = prepareConfigDirectory(dir, "apply", {
        io: nodePreparerIo(),
        label: "collision",
      });

      expect(readFileSync(collision, "utf8")).toBe("retain me");
      expect(result.backups?.agents).toBe(`${collision}-2`);
      expect(result.backups?.hub).toBe(
        join(dir, "hub.config.json.bak-glitchtip-autofix-collision"),
      );
    });
  });

  it("never removes a pre-existing colliding temporary file", () => {
    withConfigDir(({ dir, agentsPath }) => {
      const collision = `${agentsPath}.tmp-glitchtip-autofix-owned`;
      writeFileSync(collision, "not owned by this run");

      prepareConfigDirectory(dir, "apply", {
        io: nodePreparerIo(),
        label: "owned",
      });

      expect(readFileSync(collision, "utf8")).toBe("not owned by this run");
    });
  });
});
