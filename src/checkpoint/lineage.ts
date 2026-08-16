import type { CheckpointLineage, TimeMachineCheckpoint, TimelineBranch } from "../domain/types.ts";

export function lineageOf(cp: TimeMachineCheckpoint): CheckpointLineage {
  return {
    checkpointId: cp.id,
    parentCheckpointId: cp.parentCheckpointId,
    sessionId: cp.sessionId,
    branchId: cp.branchId,
  };
}

export function renderBranchTree(branches: TimelineBranch[], checkpoints: TimeMachineCheckpoint[]): string {
  const lines = ["main"];
  for (const b of branches) {
    const kids = checkpoints.filter((c) => c.branchId === b.id);
    lines.push(`├── ${b.label ?? b.id}`);
    for (const c of kids) {
      const mark = c.knownGood ? " ★" : "";
      lines.push(`│   └── ${c.id}${mark} ${c.label ?? c.reason}`);
    }
  }
  return lines.join("\n");
}
