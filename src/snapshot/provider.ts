import type {
  RestoreOptions,
  RestoreResult,
  SnapshotContext,
  WorkspaceDiff,
  WorkspaceSnapshot,
  WorkspaceSnapshotProvider,
} from "../domain/types.ts";
import type { FileSnapshotProvider } from "./file-provider.ts";
import type { GitAwareSnapshotProvider } from "./git-provider.ts";
import { detectGit } from "./git.ts";

export class CompositeSnapshotProvider implements WorkspaceSnapshotProvider {
  private readonly file: FileSnapshotProvider;
  private readonly git: GitAwareSnapshotProvider;

  constructor(file: FileSnapshotProvider, git: GitAwareSnapshotProvider) {
    this.file = file;
    this.git = git;
  }

  async createSnapshot(context: SnapshotContext): Promise<WorkspaceSnapshot> {
    const git = await detectGit(context.workspaceRoot);
    if (git) return this.git.createSnapshot(context);
    return this.file.createSnapshot(context);
  }

  restoreSnapshot(snapshot: WorkspaceSnapshot, options: RestoreOptions): Promise<RestoreResult> {
    if (snapshot.provider === "file") return this.file.restoreSnapshot(snapshot, options);
    return this.git.restoreSnapshot(snapshot, options);
  }

  diff(from: WorkspaceSnapshot, toCurrentRoot: string): Promise<WorkspaceDiff> {
    if (from.provider === "file") return this.file.diff(from, toCurrentRoot);
    return this.git.diff(from, toCurrentRoot);
  }

  async disposeSnapshot(snapshot: WorkspaceSnapshot): Promise<void> {
    await this.file.disposeSnapshot(snapshot);
  }
}
