import { chmod, lstat, mkdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  RestoreOptions,
  RestoreResult,
  SnapshotContext,
  WorkspaceDiff,
  WorkspaceSnapshot,
  WorkspaceSnapshotProvider,
} from "../domain/types.ts";
import { newId, nowIso } from "../domain/ids.ts";
import { assertSymlinkSafe, resolveInsideWorkspace } from "../paths/workspace-path.ts";
import type { BlobStore } from "../storage/blob-store.ts";
import { DEFAULT_IGNORE, entryMap, fileSignature, scanWorkspace } from "./scan.ts";

export class FileSnapshotProvider implements WorkspaceSnapshotProvider {
  constructor(
    private readonly blobs: BlobStore,
    private readonly ignore: string[] = DEFAULT_IGNORE,
    private readonly maxFileBytes = 8 * 1024 * 1024,
  ) {}

  async createSnapshot(context: SnapshotContext): Promise<WorkspaceSnapshot> {
    const baselineMap = new Map((context.baseline?.entries ?? []).map((e) => [e.path, e]));
    const scanned = await scanWorkspace({
      workspaceRoot: context.workspaceRoot,
      ignore: this.ignore,
      maxFileBytes: this.maxFileBytes,
      blobs: this.blobs,
      ownershipFor: (rel) => baselineMap.get(rel)?.ownership ?? "unknown",
    });
    return {
      id: newId("snap"),
      createdAt: nowIso(),
      root: context.workspaceRoot,
      entries: scanned.entries,
      git: scanned.git
        ? {
            head: scanned.git.head,
            branch: scanned.git.branch,
            dirty: scanned.git.dirty,
            trackedModified: scanned.git.entries.filter((e) => !e.untracked).length,
            untracked: scanned.git.entries.filter((e) => e.untracked).length,
          }
        : undefined,
      provider: "file",
    };
  }

  async restoreSnapshot(
    snapshot: WorkspaceSnapshot,
    _options: RestoreOptions,
  ): Promise<RestoreResult> {
    const restored: string[] = [];
    const failed: Array<{ path: string; reason: string }> = [];
    for (const entry of snapshot.entries) {
      try {
        if (entry.type === "directory") {
          const { abs } = await resolveInsideWorkspace(snapshot.root, entry.path);
          await mkdir(abs, { recursive: true });
          restored.push(entry.path);
          continue;
        }
        if (entry.type === "symlink") {
          const { abs } = await resolveInsideWorkspace(snapshot.root, entry.path);
          if (!entry.symlinkTarget) throw new Error("missing symlink target");
          await assertSymlinkSafe(snapshot.root, abs, entry.symlinkTarget);
          await mkdir(dirname(abs), { recursive: true });
          await rm(abs, { force: true });
          await symlink(entry.symlinkTarget, abs);
          restored.push(entry.path);
          continue;
        }
        if (!entry.hash) throw new Error("missing file hash");
        await this.blobs.verify(entry.hash);
        const buf = await this.blobs.get(entry.hash);
        const { abs } = await resolveInsideWorkspace(snapshot.root, entry.path);
        await mkdir(dirname(abs), { recursive: true });
        const tmp = `${abs}.dsh-tm-${process.pid}.tmp`;
        await writeFile(tmp, buf, { mode: 0o600 });
        await chmod(tmp, entry.mode & 0o777);
        await rm(abs, { force: true });
        const { rename } = await import("node:fs/promises");
        await rename(tmp, abs);
        restored.push(entry.path);
      } catch (err) {
        failed.push({
          path: entry.path,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const status = failed.length === 0 ? "success" : restored.length === 0 ? "failed" : "partial";
    return {
      status,
      checkpointId: snapshot.id,
      restoredPaths: restored,
      failedPaths: failed,
      preservedPaths: [],
      irreversibleEffects: [],
      verificationPassed: failed.length === 0,
      warnings: failed.map((f) => `${f.path}: ${f.reason}`),
      restoreLevel: failed.length === 0 ? "workspace-only" : "partial",
    };
  }

  async diff(from: WorkspaceSnapshot, toCurrentRoot: string): Promise<WorkspaceDiff> {
    const current = await scanWorkspace({
      workspaceRoot: toCurrentRoot,
      ignore: this.ignore,
      maxFileBytes: this.maxFileBytes,
      blobs: this.blobs,
      ownershipFor: () => "unknown",
    });
    const a = entryMap(from.entries);
    const b = entryMap(current.entries);
    const modified: WorkspaceDiff["modified"] = [];
    const created: string[] = [];
    const deleted: string[] = [];
    let unchanged = 0;
    for (const [path, entry] of a) {
      const other = b.get(path);
      if (!other) deleted.push(path);
      else if (fileSignature(entry) !== fileSignature(other)) {
        modified.push({ path, before: entry.hash, after: other.hash });
      } else unchanged += 1;
    }
    for (const [path] of b) {
      if (!a.has(path)) created.push(path);
    }
    return { modified, created, deleted, unchanged };
  }

  async disposeSnapshot(_snapshot: WorkspaceSnapshot): Promise<void> {
    // blobs are content-addressed and garbage-collected separately
  }
}

export async function currentEntry(
  workspaceRoot: string,
  rel: string,
  blobs: BlobStore,
): Promise<{ hash?: string; mode: number; type: "file" | "symlink" } | undefined> {
  const { abs } = await resolveInsideWorkspace(workspaceRoot, rel);
  try {
    const st = await lstat(abs);
    if (st.isSymbolicLink()) {
      return { type: "symlink", mode: st.mode, hash: undefined };
    }
    if (st.isFile()) {
      const buf = await (await import("node:fs/promises")).readFile(abs);
      return { type: "file", mode: st.mode, hash: blobs.hash(buf) };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export { readlink };
