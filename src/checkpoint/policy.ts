import type { CheckpointPolicy, CheckpointReason } from "../domain/types.ts";
import { basicRisk, looksDestructive, looksExternal } from "../effects/classifier.ts";

export function shouldCheckpointBeforeTool(
  policy: CheckpointPolicy,
  toolName: string,
  args: unknown,
  mutationCountSince: number,
): { yes: boolean; reason: CheckpointReason } | undefined {
  const risk = basicRisk(toolName, args);
  if (policy.beforeExternalAction && looksExternal(toolName, args)) {
    return { yes: true, reason: "pre-external-action" };
  }
  if (policy.beforeDestructiveTool && (looksDestructive(toolName, args) || risk.level === "high")) {
    return { yes: true, reason: "pre-risk-action" };
  }
  if (policy.afterMutations > 0 && mutationCountSince >= policy.afterMutations) {
    return { yes: true, reason: "automatic" };
  }
  return undefined;
}

export function checkpointRetentionScore(cp: {
  pinned: boolean;
  knownGood: boolean;
  reason: string;
  createdAt: string;
}): number {
  let score = 0;
  if (cp.pinned) score += 1000;
  if (cp.knownGood) score += 500;
  if (cp.reason === "manual") score += 200;
  if (cp.reason === "task-start" || cp.reason === "pre-restore") score += 150;
  const ageHours = (Date.now() - Date.parse(cp.createdAt)) / 36e5;
  score += Math.max(0, 100 - ageHours);
  return score;
}
