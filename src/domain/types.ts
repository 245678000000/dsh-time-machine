export const CHECKPOINT_REASONS = [
  "automatic",
  "manual",
  "pre-risk-action",
  "pre-batch-edit",
  "pre-external-action",
  "pre-restore",
  "task-start",
] as const;

export type CheckpointReason = (typeof CHECKPOINT_REASONS)[number];

export const CHECKPOINT_STATUSES = [
  "creating",
  "ready",
  "invalid",
  "corrupted",
  "pruned",
] as const;

export type CheckpointStatus = (typeof CHECKPOINT_STATUSES)[number];

export const RESTORE_LEVELS = [
  "full",
  "workspace-only",
  "session-only",
  "partial",
] as const;

export type RestoreLevel = (typeof RESTORE_LEVELS)[number];

export const MUTATION_OPERATIONS = [
  "create",
  "modify",
  "delete",
  "rename",
  "chmod",
  "unknown",
] as const;

export type MutationOperation = (typeof MUTATION_OPERATIONS)[number];

export const OWNERSHIPS = [
  "agent",
  "preexisting",
  "external",
  "unknown",
] as const;

export type Ownership = (typeof OWNERSHIPS)[number];

export const SIDE_EFFECT_CATEGORIES = [
  "filesystem",
  "git",
  "process",
  "database",
  "network",
  "external-write",
  "message",
  "deployment",
  "unknown",
] as const;

export type SideEffectCategory = (typeof SIDE_EFFECT_CATEGORIES)[number];

export const REVERSIBILITY = [
  "reversible",
  "conditionally-reversible",
  "irreversible",
  "unknown",
] as const;

export type Reversibility = (typeof REVERSIBILITY)[number];

export const LEDGER_EVENT_TYPES = [
  "timemachine/checkpoint-created",
  "timemachine/checkpoint-completed",
  "timemachine/checkpoint-failed",
  "timemachine/mutation-observed",
  "timemachine/side-effect-observed",
  "timemachine/restore-started",
  "timemachine/restore-completed",
  "timemachine/restore-partial",
  "timemachine/restore-failed",
  "timemachine/fork-created",
  "timemachine/irreversible-action",
  "timemachine/checkpoint-pruned",
] as const;

export type LedgerEventType = (typeof LEDGER_EVENT_TYPES)[number];

export interface ContentRef {
  hash: string;
  bytes: number;
  encoding?: "utf8" | "binary";
}

export interface WorkspaceSnapshotRef {
  id: string;
  kind: "git+file" | "file" | "git";
  fileCount: number;
  byteCount: number;
}

export interface GitSnapshotRef {
  head?: string;
  branch?: string;
  dirty: boolean;
  trackedModified: number;
  untracked: number;
}

export interface SessionBoundaryRef {
  sessionId: string;
  atSeq?: number;
  lastTurnEndSeq?: number;
  coherent: boolean;
  reason?: string;
}

export interface TimeMachineCheckpoint {
  id: string;
  sessionId: string;
  sessionSeq?: number;
  createdAt: string;
  reason: CheckpointReason;
  label?: string;
  workspaceSnapshot: WorkspaceSnapshotRef;
  gitSnapshot?: GitSnapshotRef;
  sessionBoundary: SessionBoundaryRef;
  sideEffectCursor: number;
  restorable: boolean;
  restoreLevel: RestoreLevel;
  warnings: string[];
  metadata: Record<string, unknown>;
  status: CheckpointStatus;
  parentCheckpointId?: string;
  branchId: string;
  pinned: boolean;
  knownGood: boolean;
  validation?: ValidationRecord;
}

export interface CheckpointLineage {
  checkpointId: string;
  parentCheckpointId?: string;
  sessionId: string;
  branchId?: string;
}

export interface FileEntry {
  path: string;
  type: "file" | "symlink" | "directory";
  mode: number;
  hash?: string;
  size?: number;
  symlinkTarget?: string;
  ownership: Ownership;
}

export interface WorkspaceSnapshot {
  id: string;
  createdAt: string;
  root: string;
  entries: FileEntry[];
  git?: GitSnapshotRef;
  provider: "git+file" | "file" | "git";
}

export interface MutationRecord {
  id: string;
  checkpointId?: string;
  toolCallId?: string;
  agentId?: string;
  sessionId?: string;
  path?: string;
  operation: MutationOperation;
  before?: ContentRef;
  after?: ContentRef;
  timestamp: string;
  ownership: Ownership;
  expected?: boolean;
}

export interface SideEffectRecord {
  id: string;
  toolCallId: string;
  toolName: string;
  timestamp: string;
  category: SideEffectCategory;
  reversibility: Reversibility;
  undoStrategy?: string;
  externalRef?: string;
  summary: string;
  details?: Record<string, unknown>;
}

export interface RestoreFailure {
  path: string;
  reason: string;
}

export interface RestoreResult {
  status: "success" | "partial" | "failed";
  checkpointId: string;
  restoredPaths: string[];
  failedPaths: RestoreFailure[];
  preservedPaths: string[];
  irreversibleEffects: SideEffectRecord[];
  verificationPassed: boolean;
  newSessionId?: string;
  emergencyCheckpointId?: string;
  warnings: string[];
  restoreLevel: RestoreLevel;
}

export interface RestorePreview {
  checkpointId: string;
  label?: string;
  willRestore: {
    modified: string[];
    deleted: string[];
    created: string[];
  };
  willPreserve: string[];
  conflicts: RestoreConflict[];
  session: {
    canFork: boolean;
    sessionId: string;
    atSeq?: number;
    reason?: string;
  };
  externalEffects: SideEffectRecord[];
  restoreLevel: RestoreLevel;
  warnings: string[];
  processStateRestored: false;
}

export interface RestoreConflict {
  path: string;
  kind: "concurrent-user" | "concurrent-external" | "symlink-escape" | "path-escape";
  message: string;
}

export interface WorkspaceDiff {
  modified: Array<{ path: string; before?: string; after?: string }>;
  created: string[];
  deleted: string[];
  unchanged: number;
}

export interface ValidationRecord {
  commands: string[];
  status: "pass" | "fail" | "skipped" | "unknown";
  results: Array<{
    command: string;
    exitCode: number;
    passed: boolean;
    output?: string;
  }>;
  ranAt: string;
}

export interface WorkspaceBaseline {
  id: string;
  createdAt: string;
  root: string;
  git?: {
    head?: string;
    branch?: string;
    dirty: boolean;
  };
  entries: FileEntry[];
}

export interface LedgerEvent {
  seq: number;
  type: LedgerEventType;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface TimelineBranch {
  id: string;
  parentBranchId?: string;
  parentCheckpointId?: string;
  sessionId: string;
  parentSessionId?: string;
  createdAt: string;
  label?: string;
}

export interface UnexpectedMutation {
  toolCallId: string;
  toolName: string;
  expectedPaths: string[];
  observedPaths: string[];
  unexpectedPaths: string[];
}

export interface TimeMachineStatus {
  workspaceRoot: string;
  dataDir: string;
  sessionId: string;
  baseline?: WorkspaceBaseline;
  checkpointCount: number;
  lastCheckpoint?: TimeMachineCheckpoint;
  lastKnownGood?: TimeMachineCheckpoint;
  pendingMutations: number;
  irreversibleEffects: number;
  gitignoreSuggested: boolean;
  lockHeld: boolean;
}

export interface CheckpointPolicy {
  onTaskStart: boolean;
  beforeDestructiveTool: boolean;
  beforeExternalAction: boolean;
  afterMutations: number;
  maxCheckpoints: number;
  maxStorageMB: number;
  retentionDays?: number;
}

export interface ValidationConfig {
  commands: string[];
}

export interface TimeMachineConfig {
  workspaceRoot: string;
  dataDir?: string;
  sessionId?: string;
  agentId?: string;
  checkpoints: CheckpointPolicy;
  validation?: ValidationConfig;
  ignore?: string[];
  maxFileBytes: number;
  requireRestoreApproval: boolean;
  suggestGitignore: boolean;
}

export const DEFAULT_CHECKPOINT_POLICY: CheckpointPolicy = {
  onTaskStart: true,
  beforeDestructiveTool: true,
  beforeExternalAction: true,
  afterMutations: 10,
  maxCheckpoints: 50,
  maxStorageMB: 2048,
  retentionDays: 30,
};

export interface SnapshotContext {
  workspaceRoot: string;
  sessionId: string;
  reason: CheckpointReason;
  label?: string;
  baseline?: WorkspaceBaseline;
  previous?: WorkspaceSnapshot;
}

export interface RestoreOptions {
  previewOnly?: boolean;
  approved?: boolean;
  mode: "workspace-only" | "fork-only" | "restore-and-fork";
  allowConflicts?: boolean;
  createEmergencyCheckpoint?: boolean;
}

export interface TimeMachineSideEffectDescriptor {
  toolName?: string;
  match?: (input: {
    toolName: string;
    args: unknown;
    result?: unknown;
  }) => boolean;
  category: SideEffectCategory;
  reversibility: Reversibility;
  undoStrategy?: string;
  summarize: (input: {
    toolName: string;
    args: unknown;
    result?: unknown;
  }) => string;
}

export interface UndoPreview {
  possible: boolean;
  summary: string;
  reversibility: Reversibility;
}

export interface UndoResult {
  status: "undone" | "not-supported" | "failed";
  summary: string;
}

export interface UndoAdapter {
  canUndo(effect: SideEffectRecord): Promise<boolean>;
  previewUndo(effect: SideEffectRecord): Promise<UndoPreview>;
  undo(effect: SideEffectRecord): Promise<UndoResult>;
}

export interface RiskSignal {
  level: "low" | "medium" | "high" | "unknown";
  reasons: string[];
}

export interface RiskSignalProvider {
  getRisk(toolCall: { name: string; args: unknown }): RiskSignal | Promise<RiskSignal>;
}

export interface WorkspaceSnapshotProvider {
  createSnapshot(context: SnapshotContext): Promise<WorkspaceSnapshot>;
  restoreSnapshot(
    snapshot: WorkspaceSnapshot,
    options: RestoreOptions,
  ): Promise<RestoreResult>;
  diff(from: WorkspaceSnapshot, toCurrentRoot: string): Promise<WorkspaceDiff>;
  disposeSnapshot(snapshot: WorkspaceSnapshot): Promise<void>;
}
