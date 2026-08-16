import { mkdir, rename, rm, symlink, writeFile, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import { TimeMachineError } from "../domain/errors.ts";
import type { FileEntry, RestoreFailure, RestoreResult } from "../domain/types.ts";
import { assertSymlinkSafe, resolveInsideWorkspace } from "../paths/workspace-path.ts";
import type { BlobStore } from "../storage/blob-store.ts";

export async function applyRestorePlan(input: {
  workspaceRoot: string;
  checkpointId: string;
  writes: FileEntry[];
  deletes: string[];
  preserves: string[];
  blobs: BlobStore;
}): Promise<Pick<RestoreResult, "status" | "restoredPaths" | "failedPaths" | "preservedPaths" | "verificationPassed">> {
  for (const entry of input.writes) {
    if (entry.hash) await input.blobs.verify(entry.hash);
    if (entry.type === "symlink" && entry.symlinkTarget) {
      const { abs } = await resolveInsideWorkspace(input.workspaceRoot, entry.path);
      await assertSymlinkSafe(input.workspaceRoot, abs, entry.symlinkTarget);
    }
  }

  const restored: string[] = [];
  const failed: RestoreFailure[] = [];
  const staged: Array<{ tmp: string; dest: string; path: string }> = [];

  try {
    for (const entry of input.writes) {
      try {
        const { abs } = await resolveInsideWorkspace(input.workspaceRoot, entry.path);
        await mkdir(dirname(abs), { recursive: true });
        if (entry.type === "directory") {
          await mkdir(abs, { recursive: true });
          restored.push(entry.path);
          continue;
        }
        if (entry.type === "symlink") {
          if (!entry.symlinkTarget) throw new Error("missing symlink target");
          await assertSymlinkSafe(input.workspaceRoot, abs, entry.symlinkTarget);
          const tmp = `${abs}.dsh-tm-stage-${process.pid}`;
          await rm(tmp, { force: true });
          await symlink(entry.symlinkTarget, tmp);
          staged.push({ tmp, dest: abs, path: entry.path });
          continue;
        }
        if (!entry.hash) throw new Error("missing hash");
        const buf = await input.blobs.get(entry.hash);
        const tmp = `${abs}.dsh-tm-stage-${process.pid}`;
        await writeFile(tmp, buf, { mode: 0o600 });
        await chmod(tmp, entry.mode & 0o777);
        staged.push({ tmp, dest: abs, path: entry.path });
      } catch (err) {
        failed.push({ path: entry.path, reason: err instanceof Error ? err.message : String(err) });
      }
    }

    if (failed.length > 0) {
      for (const s of staged) await rm(s.tmp, { force: true });
      return {
        status: restored.length > 0 ? "partial" : "failed",
        restoredPaths: restored,
        failedPaths: failed,
        preservedPaths: input.preserves,
        verificationPassed: false,
      };
    }

    for (const s of staged) {
      await rm(s.dest, { force: true });
      await rename(s.tmp, s.dest);
      restored.push(s.path);
    }

    for (const path of input.deletes) {
      try {
        const { abs } = await resolveInsideWorkspace(input.workspaceRoot, path);
        await rm(abs, { force: true });
        restored.push(path);
      } catch (err) {
        failed.push({ path, reason: err instanceof Error ? err.message : String(err) });
      }
    }
  } catch (err) {
    throw new TimeMachineError(
      "RESTORE_FAILED",
      err instanceof Error ? err.message : String(err),
    );
  }

  const status = failed.length === 0 ? "success" : restored.length === 0 ? "failed" : "partial";
  return {
    status,
    restoredPaths: restored,
    failedPaths: failed,
    preservedPaths: input.preserves,
    verificationPassed: failed.length === 0,
  };
}
