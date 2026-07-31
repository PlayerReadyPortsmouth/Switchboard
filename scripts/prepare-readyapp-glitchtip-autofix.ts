import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

type JsonRecord = Record<string, any>;

type AgentRecord = {
  access: { consultableBy?: string[] };
  runtime: { appendSystemPrompt?: string };
};

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

function assertRecord(value: unknown): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("configuration root must be an object");
  }
  return value as JsonRecord;
}

function assertAgent(agents: JsonRecord, id: string): AgentRecord {
  const agent = agents[id];
  if (
    !agent ||
    typeof agent !== "object" ||
    !agent.runtime ||
    !agent.access
  ) {
    throw new Error(`missing required agent ${id}`);
  }
  return agent as AgentRecord;
}

function assertTriggerArray(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) {
    throw new Error("spawnTriggers must be an array");
  }
  return value.map((entry) => assertRecord(entry));
}

function requireFeedbackTriggers(triggers: JsonRecord[]): void {
  for (const pattern of [
    "SPAWN_FIX\\s+(\\S+)",
    "SPAWN_FIX_QUICK\\s+(\\S+)",
  ]) {
    if (!triggers.some((trigger) => trigger.pattern === pattern)) {
      throw new Error(`missing feedback spawn trigger ${pattern}`);
    }
  }
}

function addTriggerOnce(triggers: JsonRecord[], candidate: JsonRecord): void {
  if (!triggers.some((trigger) => trigger.pattern === candidate.pattern)) {
    triggers.push(structuredClone(candidate));
  }
}

const appendOnce = (
  prompt: string,
  marker: string,
  suffix: string,
): string => (prompt.includes(marker) ? prompt : `${prompt.trimEnd()}\n\n${suffix}`);

export function prepareAgentsConfig(input: unknown): object {
  const agents = structuredClone(assertRecord(input));
  const triage = assertAgent(agents, "triage");
  const sentinel = assertAgent(agents, "prod-sentinel");
  const fix = assertAgent(agents, "fix");
  const quick = assertAgent(agents, "fix-quick");

  triage.access.consultableBy = Array.from(
    new Set([...(triage.access.consultableBy ?? []), "prod-sentinel"]),
  );
  sentinel.runtime.appendSystemPrompt = appendOnce(
    sentinel.runtime.appendSystemPrompt ?? "",
    "## GlitchTip auto-fix handoff",
    PROD_SENTINEL_SUFFIX,
  );
  triage.runtime.appendSystemPrompt = appendOnce(
    triage.runtime.appendSystemPrompt ?? "",
    "## GlitchTip candidate consults",
    TRIAGE_SUFFIX,
  );
  for (const agent of [fix, quick]) {
    agent.runtime.appendSystemPrompt = appendOnce(
      agent.runtime.appendSystemPrompt ?? "",
      "## Monitoring-card mode",
      FIX_SUFFIX,
    );
  }
  return agents;
}

export function prepareHubConfig(input: unknown): object {
  const hub = structuredClone(assertRecord(input));
  const triggers = assertTriggerArray(hub.spawnTriggers);

  for (const trigger of triggers) {
    if (
      trigger.pattern === "SPAWN_FIX\\s+(\\S+)" ||
      trigger.pattern === "SPAWN_FIX_QUICK\\s+(\\S+)"
    ) {
      trigger.sourceAgent = "triage";
    }
  }
  requireFeedbackTriggers(triggers);
  addTriggerOnce(triggers, GLITCHTIP_QUICK_TRIGGER);
  addTriggerOnce(triggers, GLITCHTIP_FIX_TRIGGER);
  hub.spawnTriggers = triggers;
  return hub;
}

type CliMode = "check" | "apply";

type CliOptions = {
  configDir: string;
  mode: CliMode;
};

function parseCliOptions(args: string[]): CliOptions {
  let configDir: string | undefined;
  const modes: CliMode[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--config-dir") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--config-dir requires a path");
      }
      if (configDir !== undefined) {
        throw new Error("--config-dir must be provided exactly once");
      }
      configDir = resolve(value);
      index += 1;
      continue;
    }
    if (argument === "--check" || argument === "--apply") {
      modes.push(argument === "--check" ? "check" : "apply");
      continue;
    }
    throw new Error(`unknown argument ${argument}`);
  }

  if (!configDir) {
    throw new Error("--config-dir is required");
  }
  if (modes.length !== 1) {
    throw new Error("exactly one of --check or --apply is required");
  }
  return { configDir, mode: modes[0] };
}

function parseJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot parse ${path}: ${message}`);
  }
}

function serializeJson(value: object): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function timestampLabel(): string {
  return `${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}-${process.pid}`;
}

function availableSiblingPath(path: string, suffix: string): string {
  const candidate = `${path}.${suffix}`;
  if (!existsSync(candidate)) return candidate;

  for (let attempt = 2; ; attempt += 1) {
    const numbered = `${candidate}-${attempt}`;
    if (!existsSync(numbered)) return numbered;
  }
}

function writeAtomic(path: string, contents: string, mode: number, label: string): void {
  const temporary = availableSiblingPath(path, `tmp-${label}`);
  try {
    writeFileSync(temporary, contents, { encoding: "utf8", mode });
    chmodSync(temporary, mode);
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function structuralSummary(
  mode: CliMode,
  configDir: string,
  originalAgents: string,
  originalHub: string,
  preparedAgents: object,
  preparedHub: object,
): object {
  const agents = assertRecord(preparedAgents);
  const triage = assertAgent(agents, "triage");
  const sentinel = assertAgent(agents, "prod-sentinel");
  const fix = assertAgent(agents, "fix");
  const quick = assertAgent(agents, "fix-quick");
  const hub = assertRecord(preparedHub);
  const triggers = assertTriggerArray(hub.spawnTriggers);

  const promptContracts = [
    triage.runtime.appendSystemPrompt?.includes("## GlitchTip candidate consults"),
    sentinel.runtime.appendSystemPrompt?.includes("## GlitchTip auto-fix handoff"),
    fix.runtime.appendSystemPrompt?.includes("## Monitoring-card mode"),
    quick.runtime.appendSystemPrompt?.includes("## Monitoring-card mode"),
  ].filter(Boolean).length;
  const feedbackPatterns = new Set([
    "SPAWN_FIX\\s+(\\S+)",
    "SPAWN_FIX_QUICK\\s+(\\S+)",
  ]);
  const glitchtipPatterns = new Set([
    GLITCHTIP_QUICK_TRIGGER.pattern,
    GLITCHTIP_FIX_TRIGGER.pattern,
  ]);

  return {
    mode,
    configDir,
    changed: {
      agents: serializeJson(preparedAgents) !== originalAgents,
      hub: serializeJson(preparedHub) !== originalHub,
    },
    agents: {
      triageConsultableByProdSentinel:
        triage.access.consultableBy?.includes("prod-sentinel") === true,
      promptContracts,
    },
    spawnTriggers: {
      total: triggers.length,
      feedbackSourceRestricted: triggers.filter(
        (trigger) =>
          feedbackPatterns.has(trigger.pattern) && trigger.sourceAgent === "triage",
      ).length,
      glitchtipSourceRestricted: triggers.filter(
        (trigger) =>
          glitchtipPatterns.has(trigger.pattern) &&
          trigger.sourceAgent === "prod-sentinel",
      ).length,
    },
  };
}

function runCli(args: string[]): void {
  const { configDir, mode } = parseCliOptions(args);
  const agentsPath = join(configDir, "agents.json");
  const hubPath = join(configDir, "hub.config.json");
  const originalAgents = readFileSync(agentsPath, "utf8");
  const originalHub = readFileSync(hubPath, "utf8");

  // Complete parsing and invariant validation before any backup or live write.
  const preparedAgents = prepareAgentsConfig(JSON.parse(originalAgents));
  const preparedHub = prepareHubConfig(JSON.parse(originalHub));
  const agentsText = serializeJson(preparedAgents);
  const hubText = serializeJson(preparedHub);
  const summary = structuralSummary(
    mode,
    configDir,
    originalAgents,
    originalHub,
    preparedAgents,
    preparedHub,
  );

  if (mode === "apply") {
    const agentsMode = statSync(agentsPath).mode & 0o777;
    const hubMode = statSync(hubPath).mode & 0o777;
    const label = timestampLabel();
    const agentsBackup = availableSiblingPath(agentsPath, `bak-${label}`);
    const hubBackup = availableSiblingPath(hubPath, `bak-${label}`);

    copyFileSync(agentsPath, agentsBackup);
    copyFileSync(hubPath, hubBackup);
    writeAtomic(agentsPath, agentsText, agentsMode, label);
    writeAtomic(hubPath, hubText, hubMode, label);

    parseJsonFile(agentsPath);
    parseJsonFile(hubPath);
  }

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (import.meta.main) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
