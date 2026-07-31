import type { SpawnTrigger } from "./types";

export type CompiledSpawnTrigger = SpawnTrigger & { re: RegExp };

export interface SpawnTriggerMatch {
  trigger: CompiledSpawnTrigger;
  groups: RegExpExecArray;
}

export function compileSpawnTriggers(
  triggers: SpawnTrigger[],
): CompiledSpawnTrigger[] {
  return triggers.map((trigger) => ({
    ...trigger,
    re: new RegExp(trigger.pattern),
  }));
}

export function matchSpawnTrigger(
  triggers: CompiledSpawnTrigger[],
  sourceAgent: string,
  text: string,
): SpawnTriggerMatch | null {
  for (const trigger of triggers) {
    if (trigger.sourceAgent && trigger.sourceAgent !== sourceAgent) continue;
    const groups = trigger.re.exec(text);
    if (groups) return { trigger, groups };
  }
  return null;
}
