import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

type JsonRecord = Record<string, unknown>;

type AgentRecord = {
  access: { consultableBy?: string[] };
  runtime: { appendSystemPrompt?: string };
};

const PROD_SENTINEL_SUFFIX = `## GlitchTip auto-fix handoff
The signed PROD_ERROR JSON includes autofixHandoff and autofixAuthorizationId. Card creation and dedup always happen first. Never consult triage for a recurrence, an activation-smoke message, a failed card write, a missing task id, or unless autofixHandoff is exactly true and autofixAuthorizationId is present. For an eligible NEW card, call ask_agent with agent "triage" and message \`GLITCHTIP_CANDIDATE <json>\` containing taskId, autofixAuthorizationId, title, description, severity, signature, release, route, and suspectedCause. Accept only an exact \`SPAWN_GLITCHTIP_FIX <same-taskId> <same-autofixAuthorizationId>\`, \`SPAWN_GLITCHTIP_FIX_QUICK <same-taskId> <same-autofixAuthorizationId>\`, or \`NO_GLITCHTIP_FIX <reason>\` reply. Re-emit an accepted SPAWN line exactly and with no other text. Every error, timeout, different task or authorization id, or malformed answer means no spawn; leave the Bug-board card for humans.`;

const TRIAGE_SUFFIX = `## GlitchTip candidate consults
On \`GLITCHTIP_CANDIDATE <json>\`, act only as a classifier. Read the named task from the ReadyAPP Bug fixes board and inspect current code/history. Never call feedback ticket stage/action endpoints and never use card tools in this consult. Return exactly one line: \`SPAWN_GLITCHTIP_FIX_QUICK <taskId> <autofixAuthorizationId>\` for a clear single-file low-risk change; \`SPAWN_GLITCHTIP_FIX <taskId> <autofixAuthorizationId>\` for complex, risky, multi-file, auth/data/money/safeguarding, or uncertain work; or \`NO_GLITCHTIP_FIX <reason>\` for smoke events, duplicates, upstream-only outages, insufficient evidence, feature requests, or non-code incidents. Echo only the supplied taskId and autofixAuthorizationId.`;

const FIX_SUFFIX = `## Monitoring-card mode
When the task starts \`Fix ReadyApp GlitchTip monitoring card\`, the identifier is a ReadyAPP Bug fixes board task, not a feedback ticket. Read it from board cmqdu2yui0000qybb4x2uyhwp using READYAPP_DATAOPS_MCP_TOKEN. Do not call \`/tickets/*\` or \`/feedback-actions/*\`. Add concise progress and final PR comments to the task. Use the task id as the Discord correlation_id. Otherwise follow the existing worktree, failing-test-first, scoped verification, assumptions, PR, feedback, and Aurora approval flow exactly. Never merge or deploy yourself.`;

const GLITCHTIP_QUICK_TRIGGER = {
  pattern: "^SPAWN_GLITCHTIP_FIX_QUICK\\s+([a-z0-9]{20,32})\\s+([A-Za-z0-9_-]{32})$",
  sourceAgent: "prod-sentinel",
  authorizationMode: "readyapp-glitchtip",
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
  pattern: "^SPAWN_GLITCHTIP_FIX\\s+([a-z0-9]{20,32})\\s+([A-Za-z0-9_-]{32})$",
  sourceAgent: "prod-sentinel",
  authorizationMode: "readyapp-glitchtip",
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
  if (!agent || typeof agent !== "object" || Array.isArray(agent)) {
    throw new Error(`missing required agent ${id}`);
  }
  const agentRecord = agent as JsonRecord;
  if (
    !agentRecord.access ||
    typeof agentRecord.access !== "object" ||
    Array.isArray(agentRecord.access)
  ) {
    throw new Error(`agent ${id} access must be an object`);
  }
  if (
    !agentRecord.runtime ||
    typeof agentRecord.runtime !== "object" ||
    Array.isArray(agentRecord.runtime)
  ) {
    throw new Error(`agent ${id} runtime must be an object`);
  }
  const access = agentRecord.access as JsonRecord;
  const runtime = agentRecord.runtime as JsonRecord;
  const consultableBy = access.consultableBy;
  if (
    consultableBy !== undefined &&
    (!Array.isArray(consultableBy) ||
      !consultableBy.every((entry: unknown) => typeof entry === "string"))
  ) {
    throw new Error(
      `agent ${id} access.consultableBy must be an array of strings`,
    );
  }
  const appendSystemPrompt = runtime.appendSystemPrompt;
  if (
    appendSystemPrompt !== undefined &&
    typeof appendSystemPrompt !== "string"
  ) {
    throw new Error(`agent ${id} runtime.appendSystemPrompt must be a string`);
  }
  return {
    access: access as AgentRecord["access"],
    runtime: runtime as AgentRecord["runtime"],
  };
}

function assertTriggerArray(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) {
    throw new Error("spawnTriggers must be an array");
  }
  return value.map((entry) => assertRecord(entry));
}

const FEEDBACK_TRIGGER_AGENTS = new Map([
  ["SPAWN_FIX\\s+(\\S+)", "fix"],
  ["SPAWN_FIX_QUICK\\s+(\\S+)", "fix-quick"],
]);

function prepareFeedbackTriggers(triggers: JsonRecord[]): void {
  for (const [pattern, agent] of FEEDBACK_TRIGGER_AGENTS) {
    const matches = triggers.filter((trigger) => trigger.pattern === pattern);
    if (matches.length !== 1) {
      throw new Error(
        `feedback spawn trigger ${pattern} must occur exactly once`,
      );
    }
    if (matches[0].agent !== agent) {
      throw new Error(`feedback spawn trigger ${pattern} must target ${agent}`);
    }
    matches[0].sourceAgent = "triage";
  }
}

function requireExactGlitchtipTrigger(
  triggers: JsonRecord[],
  candidate: JsonRecord,
): void {
  const matches = triggers.filter(
    (trigger) => trigger.pattern === candidate.pattern,
  );
  if (matches.length > 1) {
    throw new Error(
      `GlitchTip spawn trigger ${candidate.pattern} must occur at most once`,
    );
  }
  if (matches.length === 0) {
    triggers.push(structuredClone(candidate));
    return;
  }
  if (!isDeepStrictEqual(matches[0], candidate)) {
    throw new Error(
      `GlitchTip spawn trigger ${candidate.pattern} does not match the required contract`,
    );
  }
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

const appendExactSuffix = (
  prompt: string,
  agentId: string,
  marker: string,
  suffix: string,
): string => {
  const markerCount = countOccurrences(prompt, marker);
  if (markerCount === 0) {
    const existing = prompt.trimEnd();
    return existing ? `${existing}\n\n${suffix}` : suffix;
  }
  if (
    markerCount !== 1 ||
    (prompt !== suffix && !prompt.endsWith(`\n\n${suffix}`))
  ) {
    throw new Error(
      `prompt for ${agentId} has a partial or duplicate ${marker} contract`,
    );
  }
  return prompt;
};

export function prepareAgentsConfig(input: unknown): object {
  const agents = structuredClone(assertRecord(input));
  const triage = assertAgent(agents, "triage");
  const sentinel = assertAgent(agents, "prod-sentinel");
  const fix = assertAgent(agents, "fix");
  const quick = assertAgent(agents, "fix-quick");

  triage.access.consultableBy = Array.from(
    new Set([...(triage.access.consultableBy ?? []), "prod-sentinel"]),
  );
  sentinel.runtime.appendSystemPrompt = appendExactSuffix(
    sentinel.runtime.appendSystemPrompt ?? "",
    "prod-sentinel",
    "## GlitchTip auto-fix handoff",
    PROD_SENTINEL_SUFFIX,
  );
  triage.runtime.appendSystemPrompt = appendExactSuffix(
    triage.runtime.appendSystemPrompt ?? "",
    "triage",
    "## GlitchTip candidate consults",
    TRIAGE_SUFFIX,
  );
  for (const [id, agent] of [
    ["fix", fix],
    ["fix-quick", quick],
  ] as const) {
    agent.runtime.appendSystemPrompt = appendExactSuffix(
      agent.runtime.appendSystemPrompt ?? "",
      id,
      "## Monitoring-card mode",
      FIX_SUFFIX,
    );
  }
  return agents;
}

export function prepareHubConfig(input: unknown): object {
  const hub = structuredClone(assertRecord(input));
  const triggers = assertTriggerArray(hub.spawnTriggers);

  prepareFeedbackTriggers(triggers);
  requireExactGlitchtipTrigger(triggers, GLITCHTIP_QUICK_TRIGGER);
  requireExactGlitchtipTrigger(triggers, GLITCHTIP_FIX_TRIGGER);
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

function serializeJson(value: object): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function timestampLabel(): string {
  return `${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}-${process.pid}`;
}

export interface PreparerIo {
  readText(path: string): string;
  fileMode(path: string): number;
  copyExclusive(source: string, destination: string): void;
  writeExclusive(path: string, contents: string, mode: number): void;
  chmod(path: string, mode: number): void;
  rename(source: string, destination: string): void;
  exists(path: string): boolean;
  unlink(path: string): void;
}

const NODE_PREPARER_IO: PreparerIo = {
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
};

export interface PreparerSummary {
  mode: CliMode;
  configDir: string;
  changed: { agents: boolean; hub: boolean };
  agents: {
    triageConsultableByProdSentinel: boolean;
    promptContracts: number;
    promptContractsExact: boolean;
  };
  spawnTriggers: {
    total: number;
    feedbackSourceRestricted: number;
    glitchtipSourceRestricted: number;
    feedbackContractsExact: boolean;
    glitchtipContractsExact: boolean;
  };
  backups?: { agents: string; hub: string };
}

function assertExactPromptContract(
  agent: AgentRecord,
  agentId: string,
  marker: string,
  suffix: string,
): void {
  const prompt = agent.runtime.appendSystemPrompt ?? "";
  if (
    countOccurrences(prompt, marker) !== 1 ||
    (prompt !== suffix && !prompt.endsWith(`\n\n${suffix}`))
  ) {
    throw new Error(
      `prompt for ${agentId} has a partial or duplicate ${marker} contract`,
    );
  }
}

function validatePreparedAgents(input: unknown): JsonRecord {
  const agents = assertRecord(input);
  const triage = assertAgent(agents, "triage");
  const sentinel = assertAgent(agents, "prod-sentinel");
  const fix = assertAgent(agents, "fix");
  const quick = assertAgent(agents, "fix-quick");
  const sentinelGrants = (triage.access.consultableBy ?? []).filter(
    (entry) => entry === "prod-sentinel",
  );
  if (sentinelGrants.length !== 1) {
    throw new Error(
      "triage access.consultableBy must contain prod-sentinel exactly once",
    );
  }
  assertExactPromptContract(
    sentinel,
    "prod-sentinel",
    "## GlitchTip auto-fix handoff",
    PROD_SENTINEL_SUFFIX,
  );
  assertExactPromptContract(
    triage,
    "triage",
    "## GlitchTip candidate consults",
    TRIAGE_SUFFIX,
  );
  assertExactPromptContract(fix, "fix", "## Monitoring-card mode", FIX_SUFFIX);
  assertExactPromptContract(
    quick,
    "fix-quick",
    "## Monitoring-card mode",
    FIX_SUFFIX,
  );
  return agents;
}

function validatePreparedHub(input: unknown): JsonRecord {
  const hub = assertRecord(input);
  const triggers = assertTriggerArray(hub.spawnTriggers);
  for (const [pattern, agent] of FEEDBACK_TRIGGER_AGENTS) {
    const matches = triggers.filter((trigger) => trigger.pattern === pattern);
    if (matches.length !== 1) {
      throw new Error(
        `feedback spawn trigger ${pattern} must occur exactly once`,
      );
    }
    if (matches[0].agent !== agent) {
      throw new Error(`feedback spawn trigger ${pattern} must target ${agent}`);
    }
    if (matches[0].sourceAgent !== "triage") {
      throw new Error(
        `feedback spawn trigger ${pattern} must be restricted to triage`,
      );
    }
  }
  for (const candidate of [GLITCHTIP_QUICK_TRIGGER, GLITCHTIP_FIX_TRIGGER]) {
    const matches = triggers.filter(
      (trigger) => trigger.pattern === candidate.pattern,
    );
    if (matches.length !== 1 || !isDeepStrictEqual(matches[0], candidate)) {
      throw new Error(
        `GlitchTip spawn trigger ${candidate.pattern} does not match the unique required contract`,
      );
    }
  }
  return hub;
}

function parseJsonText(path: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot parse ${path}: ${message}`);
  }
}

function parsePreparedAgents(path: string, text: string): JsonRecord {
  return validatePreparedAgents(parseJsonText(path, text));
}

function parsePreparedHub(path: string, text: string): JsonRecord {
  return validatePreparedHub(parseJsonText(path, text));
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}

type ErrorWithCleanup = Error & { cleanupErrors?: Error[] };

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function attachCleanupErrors(error: unknown, cleanupErrors: Error[]): void {
  if (!(error instanceof Error) || cleanupErrors.length === 0) return;
  const target = error as ErrorWithCleanup;
  target.cleanupErrors = [...(target.cleanupErrors ?? []), ...cleanupErrors];
}

function cleanupPaths(paths: Iterable<string>, io: PreparerIo): Error[] {
  const errors: Error[] = [];
  for (const path of paths) {
    try {
      if (io.exists(path)) io.unlink(path);
    } catch (error) {
      errors.push(asError(error));
    }
  }
  return errors;
}

function createExclusiveSibling(
  path: string,
  suffix: string,
  create: (candidate: string) => void,
  io: PreparerIo,
): string {
  for (let attempt = 1; ; attempt += 1) {
    const candidate = `${path}.${suffix}${attempt === 1 ? "" : `-${attempt}`}`;
    try {
      create(candidate);
      return candidate;
    } catch (error) {
      if (isAlreadyExists(error)) continue;
      attachCleanupErrors(error, cleanupPaths([candidate], io));
      throw error;
    }
  }
}

function structuralSummary(
  mode: CliMode,
  configDir: string,
  originalAgents: string,
  originalHub: string,
  preparedAgents: object,
  preparedHub: object,
): PreparerSummary {
  const agents = validatePreparedAgents(preparedAgents);
  const triage = assertAgent(agents, "triage");
  const hub = validatePreparedHub(preparedHub);
  const triggers = assertTriggerArray(hub.spawnTriggers);

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
      promptContracts: 4,
      promptContractsExact: true,
    },
    spawnTriggers: {
      total: triggers.length,
      feedbackSourceRestricted: 2,
      glitchtipSourceRestricted: 2,
      feedbackContractsExact: true,
      glitchtipContractsExact: true,
    },
  };
}

function cleanupOwnedTemps(paths: Set<string>, io: PreparerIo): Error[] {
  const errors = cleanupPaths(paths, io);
  paths.clear();
  return errors;
}

type PrepareDirectoryOptions = {
  io?: PreparerIo;
  label?: string;
};

export function prepareConfigDirectory(
  configDir: string,
  mode: CliMode,
  options: PrepareDirectoryOptions = {},
): PreparerSummary {
  const io = options.io ?? NODE_PREPARER_IO;
  const label = options.label ?? timestampLabel();
  const agentsPath = join(configDir, "agents.json");
  const hubPath = join(configDir, "hub.config.json");
  const originalAgents = io.readText(agentsPath);
  const originalHub = io.readText(hubPath);

  const preparedAgents = prepareAgentsConfig(
    parseJsonText(agentsPath, originalAgents),
  );
  const preparedHub = prepareHubConfig(parseJsonText(hubPath, originalHub));
  const agentsText = serializeJson(preparedAgents);
  const hubText = serializeJson(preparedHub);
  const serializedAgents = parsePreparedAgents(agentsPath, agentsText);
  const serializedHub = parsePreparedHub(hubPath, hubText);
  const summary = structuralSummary(
    mode,
    configDir,
    originalAgents,
    originalHub,
    serializedAgents,
    serializedHub,
  );

  if (mode === "check") return summary;

  const agentsMode = io.fileMode(agentsPath);
  const hubMode = io.fileMode(hubPath);
  const agentsBackup = createExclusiveSibling(
    agentsPath,
    `bak-glitchtip-autofix-${label}`,
    (candidate) => io.copyExclusive(agentsPath, candidate),
    io,
  );
  const hubBackup = createExclusiveSibling(
    hubPath,
    `bak-glitchtip-autofix-${label}`,
    (candidate) => io.copyExclusive(hubPath, candidate),
    io,
  );
  summary.backups = { agents: agentsBackup, hub: hubBackup };

  const ownedTemps = new Set<string>();
  const stageText = (
    path: string,
    contents: string,
    fileMode: number,
    validate: (path: string, text: string) => JsonRecord,
  ): string => {
    const temporary = createExclusiveSibling(
      path,
      `tmp-glitchtip-autofix-${label}`,
      (candidate) => io.writeExclusive(candidate, contents, fileMode),
      io,
    );
    ownedTemps.add(temporary);
    io.chmod(temporary, fileMode);
    validate(temporary, io.readText(temporary));
    return temporary;
  };
  const stageRollback = (
    path: string,
    backup: string,
    fileMode: number,
  ): string => {
    const temporary = createExclusiveSibling(
      path,
      `tmp-glitchtip-autofix-rollback-${label}`,
      (candidate) => io.copyExclusive(backup, candidate),
      io,
    );
    ownedTemps.add(temporary);
    io.chmod(temporary, fileMode);
    return temporary;
  };

  let operationFailed = false;
  let operationError: unknown;
  try {
    const agentsTemp = stageText(
      agentsPath,
      agentsText,
      agentsMode,
      parsePreparedAgents,
    );
    const hubTemp = stageText(hubPath, hubText, hubMode, parsePreparedHub);
    const agentsRollback = stageRollback(
      agentsPath,
      agentsBackup,
      agentsMode,
    );
    const hubRollback = stageRollback(hubPath, hubBackup, hubMode);
    const replaced: Array<{
      target: string;
      rollback: string;
      kind: "agents" | "hub";
    }> = [];

    try {
      io.rename(agentsTemp, agentsPath);
      ownedTemps.delete(agentsTemp);
      replaced.push({
        target: agentsPath,
        rollback: agentsRollback,
        kind: "agents",
      });
      io.rename(hubTemp, hubPath);
      ownedTemps.delete(hubTemp);
      replaced.push({ target: hubPath, rollback: hubRollback, kind: "hub" });

      parsePreparedAgents(agentsPath, io.readText(agentsPath));
      parsePreparedHub(hubPath, io.readText(hubPath));
    } catch (error) {
      const rollbackErrors: string[] = [];
      for (const entry of [...replaced].reverse()) {
        try {
          io.rename(entry.rollback, entry.target);
          ownedTemps.delete(entry.rollback);
        } catch (rollbackError) {
          const message =
            rollbackError instanceof Error
              ? rollbackError.message
              : String(rollbackError);
          rollbackErrors.push(`${entry.kind}: ${message}`);
        }
      }
      if (rollbackErrors.length > 0) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `${message}; rollback failed for ${rollbackErrors.join(", ")}`,
        );
      }
      throw error;
    }
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  const cleanupErrors = cleanupOwnedTemps(ownedTemps, io);
  if (operationFailed) {
    attachCleanupErrors(operationError, cleanupErrors);
    throw operationError;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      "failed to remove one or more GlitchTip preparer temporary files",
    );
  }

  return summary;
}

function runCli(args: string[]): void {
  const { configDir, mode } = parseCliOptions(args);
  const summary = prepareConfigDirectory(configDir, mode);
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
