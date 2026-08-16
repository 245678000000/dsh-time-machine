import type {
  FileEntry,
  MutationRecord,
  Ownership,
  RestoreConflict,
  RestorePreview,
  SideEffectRecord,
  TimeMachineCheckpoint,
  WorkspaceSnapshot,
} from "../domain/types.ts";
import { entryMap, fileSignature } from "../snapshot/scan.ts";

export interface RestorePlan {
  preview: RestorePreview;
  writes: FileEntry[];
  deletes: string[];
  preserves: string[];
}

export function classifyCurrentOwnership(
  path: string,
  baseline?: FileEntry,
  lastAgent?: MutationRecord,
  currentSig?: string,
  desiredSig?: string,
): Ownership {
  if (lastAgent && lastAgent.ownership === "agent") {
    const afterSig = lastAgent.after?.hash;
    if (currentSig && afterSig && !currentSig.includes(afterSig) && currentSig !== desiredSig) {
      return "external";
    }
    return "agent";
  }
  if (baseline) return "preexisting";
  return "unknown";
}

export function planRestore(input: {
  checkpoint: TimeMachineCheckpoint;
  desired: WorkspaceSnapshot;
  current: WorkspaceSnapshot;
  baseline?: WorkspaceSnapshot | { entries: FileEntry[] };
  mutations: MutationRecord[];
  effects: SideEffectRecord[];
}): RestorePlan {
  const desired = entryMap(input.desired.entries);
  const current = entryMap(input.current.entries);
  const baseline = entryMap(input.baseline?.entries ?? []);
  const lastAgentByPath = new Map<string, MutationRecord>();
  for (const m of input.mutations) {
    if (m.path && m.ownership === "agent") lastAgentByPath.set(m.path, m);
  }

  const writes: FileEntry[] = [];
  const deletes: string[] = [];
  const preserves: string[] = [];
  const conflicts: RestoreConflict[] = [];
  const modified: string[] = [];
  const created: string[] = [];
  const deleted: string[] = [];

  const allPaths = new Set([...desired.keys(), ...current.keys()]);
  for (const path of allPaths) {
    const want = desired.get(path);
    const have = current.get(path);
    const base = baseline.get(path);
    const lastAgent = lastAgentByPath.get(path);
    const currentSig = have ? fileSignature(have) : undefined;
    const desiredSig = want ? fileSignature(want) : undefined;
    const ownership = classifyCurrentOwnership(path, base, lastAgent, currentSig, desiredSig);

    if (want && have && fileSignature(want) === fileSignature(have)) {
      continue;
    }

    if (ownership === "preexisting" && !lastAgent) {
      if (have && (!want || fileSignature(have) !== fileSignature(want))) {
        preserves.push(path);
        continue;
      }
      if (!have && want && base && fileSignature(want) === fileSignature(base)) {
        preserves.push(path);
        continue;
      }
    }

    if (ownership === "external") {
      conflicts.push({
        path,
        kind: "concurrent-external",
        message: `Concurrent change detected at ${path}; refusing silent overwrite.`,
      });
      continue;
    }

    if (want && !have) {
      writes.push(want);
      deleted.push(path);
      continue;
    }
    if (!want && have) {
      if (ownership === "agent") {
        deletes.push(path);
        created.push(path);
        continue;
      }
      preserves.push(path);
      continue;
    }
    if (want && have) {
      writes.push(want);
      modified.push(path);
    }
  }

  const irreversible = input.effects.filter(
    (e) => e.reversibility === "irreversible" || e.reversibility === "conditionally-reversible" || e.reversibility === "unknown",
  );

  const warnings: string[] = [...input.checkpoint.warnings];
  if (irreversible.length > 0) {
    warnings.push(
      `WORKSPACE CAN BE RESTORED BUT ${irreversible.length} side effect(s) cannot automatically be undone.`,
    );
  }
  warnings.push("PROCESS STATE NOT RESTORED");

  let restoreLevel: RestorePreview["restoreLevel"] = "full";
  if (!input.checkpoint.sessionBoundary.coherent) restoreLevel = "workspace-only";
  if (irreversible.length > 0 || preserves.length > 0 || conflicts.length > 0) restoreLevel = "partial";

  return {
    preview: {
      checkpointId: input.checkpoint.id,
      label: input.checkpoint.label,
      willRestore: { modified, deleted, created },
      willPreserve: preserves,
      conflicts,
      session: {
        canFork: input.checkpoint.sessionBoundary.coherent,
        sessionId: input.checkpoint.sessionBoundary.sessionId,
        atSeq: input.checkpoint.sessionBoundary.atSeq ?? input.checkpoint.sessionBoundary.lastTurnEndSeq,
        reason: input.checkpoint.sessionBoundary.reason,
      },
      externalEffects: irreversible,
      restoreLevel,
      warnings,
      processStateRestored: false,
    },
    writes,
    deletes,
    preserves,
  };
}
