import type {
  RestoreOptions,
  RestoreResult,
  SnapshotContext,
  WorkspaceDiff,
  WorkspaceSnapshot,
  WorkspaceSnapshotProvider,
} from "../domain/types.ts";
import type { FileSnapshotProvider } from "./file-provider.ts";
import { detectGit } from "./git.ts";

/**
 * Git-aware snapshot: uses git status / ls-files to see dirty + tracked files,
 * but NEVER restores with `git reset --hard` or `git clean -fd`.
 * File contents are always written through the file provider + blob store.
 */
export class GitAwareSnapshotProvider implements WorkspaceSnapshotProvider {
  constructor(private readonly files: FileSnapshotProvider) {}

  async createSnapshot(context: SnapshotContext): Promise<WorkspaceSnapshot> {
    const snapshot = await this.files.createSnapshot(context);
    const git = await detectGit(context.workspaceRoot);
    return {
      ...snapshot,
      provider: git ? "git+file" : "file",
      git: git
        ? {
            head: git.head,
            branch: git.branch,
            dirty: git.dirty,
            trackedModified: git.entries.filter((e) => !e.untracked).length,
            untracked: git.entries.filter((e) => e.untracked).length,
          }
        : snapshot.git,
    };
  }

  restoreSnapshot(snapshot: WorkspaceSnapshot, options: RestoreOptions): Promise<RestoreResult> {
    return this.files.restoreSnapshot(snapshot, options);
  }

  diff(from: WorkspaceSnapshot, toCurrentRoot: string): Promise<WorkspaceDiff> {
    return this.files.diff(from, toCurrentRoot);
  }

  disposeSnapshot(snapshot: WorkspaceSnapshot): Promise<void> {
    return this.files.disposeSnapshot(snapshot);
  }
}
