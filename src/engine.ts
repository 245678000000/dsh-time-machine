import { access } from "node:fs/promises";
import { join, relative } from "node:path";
import type { HarnessSessionAdapter } from "./adapters/harness/session-adapter.ts";
import type { HarnessApprovalAdapter as ApprovalPort } from "./adapters/harness/types.ts";
import type { SessionEventLike } from "./session/boundary.ts";
import { TimeMachineError } from "./domain/errors.ts";
import { newId, nowIso } from "./domain/ids.ts";
import type {
  FileEntry,
  MutationRecord,
  RestoreOptions,
  RestorePreview,
  RestoreResult,
  RiskSignalProvider,
  SideEffectRecord,
  SnapshotContext,
  TimeMachineCheckpoint,
  TimeMachineConfig,
  TimeMachineSideEffectDescriptor,
  TimeMachineStatus,
  TimelineBranch,
  UnexpectedMutation,
  WorkspaceBaseline,
  WorkspaceDiff,
  WorkspaceSnapshot,
} from "./domain/types.ts";
import { DEFAULT_CHECKPOINT_POLICY } from "./domain/types.ts";
import { checkpointRetentionScore, shouldCheckpointBeforeTool } from "./checkpoint/policy.ts";
import { classifySideEffect, expectedPathsFromArgs } from "./effects/classifier.ts";
import { NoopUndoAdapter } from "./effects/adapters.ts";
import { resolveWorkspaceRoot, toPosixRel } from "./paths/workspace-path.ts";
import { deriveSessionBoundary } from "./session/boundary.ts";
import { FileSnapshotProvider } from "./snapshot/file-provider.ts";
import { GitAwareSnapshotProvider } from "./snapshot/git-provider.ts";
import { CompositeSnapshotProvider } from "./snapshot/provider.ts";
import { DEFAULT_IGNORE, fileSignature, scanWorkspace } from "./snapshot/scan.ts";
import { detectGit } from "./snapshot/git.ts";
import { CheckpointStore, defaultDataDir } from "./storage/store.ts";
import { planRestore } from "./restore/planner.ts";
import { applyRestorePlan } from "./restore/executor.ts";
import { verifyRestoredState } from "./restore/verifier.ts";
import { runValidationCommands } from "./validation/runner.ts";

export interface EngineAdapters {
  session?: HarnessSessionAdapter;
  approval?: ApprovalPort;
  risk?: RiskSignalProvider;
}

export class TimeMachineEngine {
  readonly store: CheckpointStore;
  readonly workspaceRoot: string;
  readonly dataDir: string;
  readonly config: TimeMachineConfig;
  sessionId: string;
  agentId?: string;
  private readonly provider: CompositeSnapshotProvider;
  private readonly ignore: string[];
  private readonly descriptors: TimeMachineSideEffectDescriptor[] = [];
  private readonly undo = new NoopUndoAdapter();
  private adapters: EngineAdapters = {};
  private sessionEvents: SessionEventLike[] = [];
  private openTool = false;
  private openTurn = false;
  private mutationsSinceCheckpoint = 0;
  private lastObserved = new Map<string, string>();

  private constructor(opts: {
    workspaceRoot: string;
    dataDir: string;
    store: CheckpointStore;
    config: TimeMachineConfig;
  }) {
    this.workspaceRoot = opts.workspaceRoot;
    this.dataDir = opts.dataDir;
    this.store = opts.store;
    this.config = opts.config;
    this.sessionId = opts.config.sessionId ?? "local";
    this.agentId = opts.config.agentId;
    this.ignore = [...DEFAULT_IGNORE, ...(opts.config.ignore ?? [])];
    const files = new FileSnapshotProvider(opts.store.blobs, this.ignore, opts.config.maxFileBytes);
    this.provider = new CompositeSnapshotProvider(files, new GitAwareSnapshotProvider(files));
  }

  static async open(config: Partial<TimeMachineConfig> & { workspaceRoot: string }): Promise<TimeMachineEngine> {
    const workspaceRoot = await resolveWorkspaceRoot(config.workspaceRoot);
    const full: TimeMachineConfig = {
      workspaceRoot,
      dataDir: config.dataDir,
      sessionId: config.sessionId,
      agentId: config.agentId,
      checkpoints: { ...DEFAULT_CHECKPOINT_POLICY, ...config.checkpoints },
      validation: config.validation,
      ignore: config.ignore,
      maxFileBytes: config.maxFileBytes ?? 8 * 1024 * 1024,
      requireRestoreApproval: config.requireRestoreApproval ?? true,
      suggestGitignore: config.suggestGitignore ?? true,
    };
    const dataDir = defaultDataDir(workspaceRoot, full.dataDir);
    const store = new CheckpointStore(dataDir);
    await store.open();
    const engine = new TimeMachineEngine({ workspaceRoot, dataDir, store, config: full });
    if (!store.getMeta("workspaceRoot")) store.setMeta("workspaceRoot", workspaceRoot);
    if (!store.listBranches().some((b) => b.id === "main")) {
      store.saveBranch({
        id: "main",
        sessionId: engine.sessionId,
        createdAt: nowIso(),
        label: "main",
      });
    }
    return engine;
  }

  setAdapters(adapters: EngineAdapters): void {
    this.adapters = adapters;
  }

  registerDescriptor(descriptor: TimeMachineSideEffectDescriptor): void {
    this.descriptors.push(descriptor);
  }

  noteSessionEvent(event: SessionEventLike): void {
    this.sessionEvents.push(event);
    if (event.type === "turn/start") this.openTurn = true;
    if (event.type === "turn/end") this.openTurn = false;
    if (event.type === "tool/call") this.openTool = true;
    if (event.type === "tool/result") this.openTool = false;
  }

  async status(): Promise<TimeMachineStatus> {
    const cps = this.store.listCheckpoints().filter((c) => c.status !== "pruned");
    const last = cps.at(-1);
    const lastKnownGood = [...cps].reverse().find((c) => c.knownGood);
    return {
      workspaceRoot: this.workspaceRoot,
      dataDir: this.dataDir,
      sessionId: this.sessionId,
      baseline: this.store.loadBaseline(),
      checkpointCount: cps.length,
      lastCheckpoint: last,
      lastKnownGood,
      pendingMutations: this.mutationsSinceCheckpoint,
      irreversibleEffects: this.store
        .listSideEffects()
        .filter((e) => e.reversibility === "irreversible").length,
      gitignoreSuggested: await this.shouldSuggestGitignore(),
      lockHeld: this.store.lock.isHeld,
    };
  }

  async ensureBaseline(sessionId = this.sessionId): Promise<WorkspaceBaseline> {
    const existing = this.store.loadBaseline();
    if (existing) return existing;
    const snapshot = await this.scanNow("preexisting");
    const git = await detectGit(this.workspaceRoot);
    const baseline: WorkspaceBaseline = {
      id: newId("base"),
      createdAt: nowIso(),
      root: this.workspaceRoot,
      git: git ? { head: git.head, branch: git.branch, dirty: git.dirty } : undefined,
      entries: snapshot.entries.map((e) => ({ ...e, ownership: "preexisting" })),
    };
    this.store.saveBaseline(baseline);
    this.sessionId = sessionId;
    this.store.setMeta("sessionId", sessionId);
    if (this.config.checkpoints.onTaskStart) {
      await this.checkpoint({ reason: "task-start", label: "workspace baseline / task start", sessionId });
    }
    return baseline;
  }

  async checkpoint(input: {
    reason: TimeMachineCheckpoint["reason"];
    label?: string;
    sessionId?: string;
    metadata?: Record<string, unknown>;
    pinned?: boolean;
  }): Promise<TimeMachineCheckpoint> {
    if (this.openTool) {
      const failed = this.placeholderCheckpoint(input, false, "Refused full restore point during an open tool call.");
      this.store.appendLedger("timemachine/checkpoint-failed", { reason: failed.warnings[0], label: input.label });
      return failed;
    }
    await this.ensureBaseline(input.sessionId ?? this.sessionId);
    const creating = this.placeholderCheckpoint(input, true);
    this.store.saveCheckpoint(creating);
    this.store.appendLedger("timemachine/checkpoint-created", { id: creating.id, reason: input.reason });
    try {
      const context: SnapshotContext = {
        workspaceRoot: this.workspaceRoot,
        sessionId: input.sessionId ?? this.sessionId,
        reason: input.reason,
        label: input.label,
        baseline: this.store.loadBaseline(),
      };
      const snapshot = await this.provider.createSnapshot(context);
      await this.persistSnapshot(snapshot);
      const git = snapshot.git;
      const boundary = deriveSessionBoundary({
        sessionId: input.sessionId ?? this.sessionId,
        events: this.sessionEvents,
        openTurn: this.openTurn,
        openTool: this.openTool,
      });
      const parent = this.latestReady();
      const warnings = [...snapshot.entries.filter((e) => !e.hash && e.type === "file").map((e) => `No blob for ${e.path}`)];
      if (!boundary.coherent) warnings.push(boundary.reason ?? "Session boundary is not fork-safe.");
      warnings.push("PROCESS STATE NOT RESTORED");
      const cp: TimeMachineCheckpoint = {
        ...creating,
        status: "ready",
        restorable: true,
        restoreLevel: boundary.coherent ? "full" : "workspace-only",
        workspaceSnapshot: {
          id: snapshot.id,
          kind: snapshot.provider,
          fileCount: snapshot.entries.filter((e) => e.type === "file").length,
          byteCount: snapshot.entries.reduce((n, e) => n + (e.size ?? 0), 0),
        },
        gitSnapshot: git,
        sessionBoundary: boundary,
        sideEffectCursor: this.store.sideEffectCursor(),
        warnings,
        parentCheckpointId: parent?.id,
        pinned: Boolean(input.pinned),
      };
      this.store.saveCheckpoint(cp);
      this.store.appendLedger("timemachine/checkpoint-completed", { id: cp.id });
      this.mutationsSinceCheckpoint = 0;
      await this.maybeValidate(cp);
      await this.pruneIfNeeded();
      return this.store.getCheckpoint(cp.id) ?? cp;
    } catch (err) {
      creating.status = "invalid";
      creating.restorable = false;
      creating.warnings.push(err instanceof Error ? err.message : String(err));
      this.store.saveCheckpoint(creating);
      this.store.appendLedger("timemachine/checkpoint-failed", { id: creating.id, error: creating.warnings.at(-1) });
      throw err;
    }
  }

  list(): TimeMachineCheckpoint[] {
    return this.store.listCheckpoints().filter((c) => c.status !== "pruned");
  }

  branches(): TimelineBranch[] {
    return this.store.listBranches();
  }

  effects(): SideEffectRecord[] {
    return this.store.listSideEffects();
  }

  mutations(): MutationRecord[] {
    return this.store.listMutations();
  }

  ledger() {
    return this.store.listLedger();
  }

  async diff(checkpointId: string): Promise<WorkspaceDiff> {
    const snap = await this.loadSnapshotOrThrow(checkpointId);
    return this.provider.diff(snap, this.workspaceRoot);
  }

  async previewRestore(checkpointId: string): Promise<RestorePreview> {
    const plan = await this.buildPlan(checkpointId);
    return plan.preview;
  }

  async restore(
    checkpointId: string,
    options: Partial<RestoreOptions> = {},
  ): Promise<RestoreResult> {
    const mode = options.mode ?? "restore-and-fork";
    const opts: RestoreOptions = {
      mode,
      approved: options.approved ?? false,
      allowConflicts: options.allowConflicts ?? false,
      createEmergencyCheckpoint: options.createEmergencyCheckpoint ?? true,
      previewOnly: options.previewOnly,
    };

    if (mode === "fork-only") {
      return this.forkOnly(checkpointId);
    }

    const plan = await this.buildPlan(checkpointId);
    if (opts.previewOnly) {
      return {
        status: "failed",
        checkpointId,
        restoredPaths: [],
        failedPaths: [],
        preservedPaths: plan.preserves,
        irreversibleEffects: plan.preview.externalEffects,
        verificationPassed: false,
        warnings: ["preview-only: no files written"],
        restoreLevel: plan.preview.restoreLevel,
      };
    }

    if (plan.preview.conflicts.length > 0 && !opts.allowConflicts) {
      this.store.appendLedger("timemachine/restore-failed", {
        checkpointId,
        reason: "RESTORE_CONFLICT",
        conflicts: plan.preview.conflicts,
      });
      throw new TimeMachineError(
        "RESTORE_CONFLICT",
        "Restore would overwrite concurrent changes.",
        { conflicts: plan.preview.conflicts },
      );
    }

    if (this.config.requireRestoreApproval && !opts.approved) {
      const ok = this.adapters.approval
        ? await this.adapters.approval.requestRestoreApproval(formatPreview(plan.preview))
        : false;
      if (!ok) {
        throw new TimeMachineError(
          "APPROVAL_REQUIRED",
          "Restore requires explicit approval. Re-run with approved: true after preview.",
          { checkpointId },
        );
      }
    }

    await this.store.lock.acquire();
    this.store.appendLedger("timemachine/restore-started", { checkpointId, mode });
    let emergencyId: string | undefined;
    try {
      if (opts.createEmergencyCheckpoint) {
        const emergency = await this.checkpoint({
          reason: "pre-restore",
          label: `emergency before restore ${checkpointId}`,
          pinned: true,
        });
        emergencyId = emergency.id;
      }

      const desired = await this.loadSnapshotOrThrow(checkpointId);
      await this.verifySnapshotIntegrity(desired);

      const applied = await applyRestorePlan({
        workspaceRoot: this.workspaceRoot,
        checkpointId,
        writes: plan.writes,
        deletes: plan.deletes,
        preserves: plan.preserves,
        blobs: this.store.blobs,
      });

      const verify = await verifyRestoredState({
        workspaceRoot: this.workspaceRoot,
        desired: desired.entries,
        ignore: this.ignore,
        maxFileBytes: this.config.maxFileBytes,
        blobs: this.store.blobs,
        preserve: new Set(plan.preserves),
      });

      let status = applied.status;
      if (!verify.passed && status === "success") status = "partial";
      if (status === "success" && applied.failedPaths.length > 0) status = "partial";

      let newSessionId: string | undefined;
      const cp = this.requireCheckpoint(checkpointId);
      if (mode === "restore-and-fork") {
        try {
          newSessionId = (await this.forkSession(cp)).sessionId;
        } catch (err) {
          plan.preview.warnings.push(err instanceof Error ? err.message : String(err));
        }
      }

      const result: RestoreResult = {
        status,
        checkpointId,
        restoredPaths: applied.restoredPaths,
        failedPaths: applied.failedPaths,
        preservedPaths: applied.preservedPaths,
        irreversibleEffects: plan.preview.externalEffects,
        verificationPassed: verify.passed && applied.failedPaths.length === 0,
        newSessionId,
        emergencyCheckpointId: emergencyId,
        warnings: [
          ...plan.preview.warnings,
          ...verify.mismatches.map((p) => `verification mismatch: ${p}`),
        ],
        restoreLevel:
          status === "success" && plan.preview.restoreLevel === "full" ? "full" : status === "success" ? plan.preview.restoreLevel : "partial",
      };

      if (status === "success") this.store.appendLedger("timemachine/restore-completed", { result });
      else if (status === "partial") this.store.appendLedger("timemachine/restore-partial", { result });
      else this.store.appendLedger("timemachine/restore-failed", { result });

      if (status === "success" && !result.verificationPassed) {
        result.status = "partial";
      }
      return result;
    } catch (err) {
      this.store.appendLedger("timemachine/restore-failed", {
        checkpointId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      await this.store.lock.release();
    }
  }

  async forkOnly(checkpointId: string): Promise<RestoreResult> {
    const cp = this.requireCheckpoint(checkpointId);
    const forked = await this.forkSession(cp);
    return {
      status: "success",
      checkpointId,
      restoredPaths: [],
      failedPaths: [],
      preservedPaths: [],
      irreversibleEffects: this.effectsSince(cp.sideEffectCursor),
      verificationPassed: true,
      newSessionId: forked.sessionId,
      warnings: ["Fork-only: workspace was not modified."],
      restoreLevel: "session-only",
    };
  }

  async observeToolPre(input: {
    toolName: string;
    args: unknown;
    toolCallId: string;
    sessionId?: string;
    agentId?: string;
  }): Promise<{ checkpoint?: TimeMachineCheckpoint }> {
    await this.ensureBaseline(input.sessionId ?? this.sessionId);
    this.openTool = true;
    const before = await this.scanNow();
    this.lastObserved = sigMap(before.entries);
    const decision = shouldCheckpointBeforeTool(
      this.config.checkpoints,
      input.toolName,
      input.args,
      this.mutationsSinceCheckpoint,
    );
    let checkpoint: TimeMachineCheckpoint | undefined;
    if (decision?.yes) {
      checkpoint = await this.checkpoint({
        reason: decision.reason,
        label: `before ${input.toolName}`,
        sessionId: input.sessionId ?? this.sessionId,
        metadata: { toolName: input.toolName, toolCallId: input.toolCallId },
      });
    }
    return { checkpoint };
  }

  async observeToolResult(input: {
    toolName: string;
    args: unknown;
    toolCallId: string;
    sessionId?: string;
    agentId?: string;
    result?: unknown;
    isError?: boolean;
  }): Promise<{ mutations: MutationRecord[]; effect: SideEffectRecord; unexpected?: UnexpectedMutation }> {
    this.openTool = false;
    const after = await this.scanNow();
    const afterMap = sigMap(after.entries);
    const expected = normalizeExpected(this.workspaceRoot, expectedPathsFromArgs(input.args));
    const observedPaths: string[] = [];
    const mutations: MutationRecord[] = [];
    const all = new Set([...this.lastObserved.keys(), ...afterMap.keys()]);
    for (const path of all) {
      const beforeSig = this.lastObserved.get(path);
      const afterSig = afterMap.get(path);
      if (beforeSig === afterSig) continue;
      observedPaths.push(path);
      let operation: MutationRecord["operation"] = "unknown";
      if (!beforeSig && afterSig) operation = "create";
      else if (beforeSig && !afterSig) operation = "delete";
      else operation = "modify";
      const ownership: MutationRecord["ownership"] = "agent";
      const afterEntry = after.entries.find((e) => e.path === path);
      const rec: MutationRecord = {
        id: newId("mut"),
        toolCallId: input.toolCallId,
        agentId: input.agentId ?? this.agentId,
        sessionId: input.sessionId ?? this.sessionId,
        path,
        operation,
        timestamp: nowIso(),
        ownership,
        expected: expected.length === 0 || expected.some((e) => path === e || path.endsWith(e)),
        after: afterEntry?.hash
          ? { hash: afterEntry.hash, bytes: afterEntry.size ?? 0 }
          : undefined,
      };
      this.store.addMutation(rec);
      this.store.appendLedger("timemachine/mutation-observed", { ...rec });
      mutations.push(rec);
    }

    const unexpectedPaths = observedPaths.filter(
      (p) => expected.length > 0 && !expected.some((e) => p === e || p.endsWith(e)),
    );
    const unexpected: UnexpectedMutation | undefined =
      unexpectedPaths.length > 0
        ? {
            toolCallId: input.toolCallId,
            toolName: input.toolName,
            expectedPaths: expected,
            observedPaths,
            unexpectedPaths,
          }
        : undefined;

    const effect = classifySideEffect({
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      args: input.args,
      result: input.result,
      descriptors: this.descriptors,
    });
    this.store.addSideEffect(effect);
    this.store.appendLedger("timemachine/side-effect-observed", { ...effect });
    if (effect.reversibility === "irreversible") {
      this.store.appendLedger("timemachine/irreversible-action", { ...effect });
    }

    this.mutationsSinceCheckpoint += mutations.length;
    this.lastObserved = afterMap;
    return { mutations, effect, unexpected };
  }

  async pin(id: string, pinned = true): Promise<TimeMachineCheckpoint> {
    const cp = this.requireCheckpoint(id);
    cp.pinned = pinned;
    this.store.saveCheckpoint(cp);
    return cp;
  }

  async validate(id?: string): Promise<TimeMachineCheckpoint | undefined> {
    const cp = id ? this.requireCheckpoint(id) : this.latestReady();
    if (!cp) return undefined;
    return this.maybeValidate(cp, true);
  }

  lastKnownGood(): TimeMachineCheckpoint | undefined {
    return [...this.list()].reverse().find((c) => c.knownGood && c.status === "ready");
  }

  async restoreLastKnownGood(options: Partial<RestoreOptions> = {}): Promise<RestoreResult> {
    const cp = this.lastKnownGood();
    if (!cp) throw new TimeMachineError("CHECKPOINT_NOT_FOUND", "No known-good checkpoint exists.");
    return this.restore(cp.id, options);
  }

  async findFirstBad(options?: { commands?: string[]; isolated?: boolean }): Promise<{
    firstBad?: TimeMachineCheckpoint;
    lastGood?: TimeMachineCheckpoint;
    tested: Array<{ id: string; status: string }>;
    method: "stored-validation" | "isolated-bisect";
  }> {
    const ready = this.list().filter((c) => c.status === "ready" && c.restorable);
    const commands = options?.commands ?? this.config.validation?.commands ?? [];
    if (ready.some((c) => c.validation) && !options?.isolated) {
      let lastGood: TimeMachineCheckpoint | undefined;
      let firstBad: TimeMachineCheckpoint | undefined;
      const tested: Array<{ id: string; status: string }> = [];
      for (const cp of ready) {
        const status = cp.validation?.status ?? "unknown";
        tested.push({ id: cp.id, status });
        if (status === "pass") lastGood = cp;
        if (status === "fail" && !firstBad) firstBad = cp;
      }
      return { firstBad, lastGood, tested, method: "stored-validation" };
    }
    if (commands.length === 0) {
      return { tested: ready.map((c) => ({ id: c.id, status: c.validation?.status ?? "unknown" })), method: "stored-validation" };
    }
    return this.isolatedBisect(ready, commands);
  }

  private async isolatedBisect(
    ready: TimeMachineCheckpoint[],
    commands: string[],
  ): Promise<{
    firstBad?: TimeMachineCheckpoint;
    lastGood?: TimeMachineCheckpoint;
    tested: Array<{ id: string; status: string }>;
    method: "isolated-bisect";
  }> {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const tested: Array<{ id: string; status: string }> = [];
    let lo = 0;
    let hi = ready.length - 1;
    let lastGood: TimeMachineCheckpoint | undefined;
    let firstBad: TimeMachineCheckpoint | undefined;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const cp = ready[mid];
      if (!cp) break;
      const dir = await mkdtemp(join(tmpdir(), "dsh-tm-bisect-"));
      try {
        const snap = await this.loadSnapshotOrThrow(cp.id);
        const isolated: WorkspaceSnapshot = { ...snap, root: dir };
        await this.provider.restoreSnapshot(isolated, { mode: "workspace-only", approved: true });
        const result = await runValidationCommands(dir, commands);
        tested.push({ id: cp.id, status: result.status });
        if (result.status === "pass") {
          lastGood = cp;
          lo = mid + 1;
        } else {
          firstBad = cp;
          hi = mid - 1;
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
    return { firstBad, lastGood, tested, method: "isolated-bisect" };
  }

  private async maybeValidate(cp: TimeMachineCheckpoint, force = false): Promise<TimeMachineCheckpoint> {
    const commands = this.config.validation?.commands ?? [];
    if (!force && commands.length === 0) return cp;
    if (commands.length === 0) {
      this.store.updateValidation(
        cp.id,
        { commands: [], status: "skipped", results: [], ranAt: nowIso() },
        false,
      );
      return this.store.getCheckpoint(cp.id) ?? cp;
    }
    const ran = await runValidationCommands(this.workspaceRoot, commands);
    const knownGood = ran.status === "pass";
    this.store.updateValidation(
      cp.id,
      { commands, status: ran.status, results: ran.results, ranAt: nowIso() },
      knownGood,
    );
    return this.store.getCheckpoint(cp.id) ?? cp;
  }

  private async forkSession(cp: TimeMachineCheckpoint): Promise<{ sessionId: string }> {
    if (!cp.sessionBoundary.coherent) {
      throw new TimeMachineError(
        "UNSAFE_BOUNDARY",
        cp.sessionBoundary.reason ?? "Checkpoint is not a coherent session fork boundary.",
        { checkpointId: cp.id },
      );
    }
    const atSeq = cp.sessionBoundary.atSeq ?? cp.sessionBoundary.lastTurnEndSeq;
    if (!this.adapters.session) {
      const rec = new (await import("./adapters/harness/session-adapter.ts")).RecordingSessionAdapter();
      const child = await rec.fork({ sessionId: cp.sessionBoundary.sessionId, atSeq });
      this.store.saveBranch({
        id: newId("br"),
        parentBranchId: cp.branchId,
        parentCheckpointId: cp.id,
        sessionId: child.sessionId,
        parentSessionId: cp.sessionId,
        createdAt: nowIso(),
        label: `fork of ${cp.id}`,
      });
      this.store.appendLedger("timemachine/fork-created", {
        parent: cp.sessionId,
        child: child.sessionId,
        atSeq,
        note: "Recording adapter used because official session.fork was not injected.",
      });
      return child;
    }
    const child = await this.adapters.session.fork({
      sessionId: cp.sessionBoundary.sessionId,
      atSeq,
    });
    this.store.saveBranch({
      id: newId("br"),
      parentBranchId: cp.branchId,
      parentCheckpointId: cp.id,
      sessionId: child.sessionId,
      parentSessionId: cp.sessionId,
      createdAt: nowIso(),
      label: `fork of ${cp.id}`,
    });
    this.store.appendLedger("timemachine/fork-created", {
      parent: cp.sessionId,
      child: child.sessionId,
      atSeq,
    });
    return child;
  }

  private async buildPlan(checkpointId: string) {
    const cp = this.requireCheckpoint(checkpointId);
    if (cp.status !== "ready") {
      throw new TimeMachineError("CHECKPOINT_NOT_READY", `Checkpoint ${checkpointId} is ${cp.status}.`);
    }
    const desired = await this.loadSnapshotOrThrow(checkpointId);
    await this.verifySnapshotIntegrity(desired);
    const current = await this.scanNow();
    const baseline = this.store.loadBaseline();
    return planRestore({
      checkpoint: cp,
      desired,
      current,
      baseline,
      mutations: this.store.listMutations(),
      effects: this.effectsSince(cp.sideEffectCursor),
    });
  }

  private effectsSince(cursor: number): SideEffectRecord[] {
    const all = this.store.listSideEffects();
    // cursor is the seq at checkpoint time; effects after that remain live
    return all.slice(cursor);
  }

  private async scanNow(ownership: FileEntry["ownership"] = "unknown"): Promise<WorkspaceSnapshot> {
    const baseline = this.store.loadBaseline();
    const scanned = await scanWorkspace({
      workspaceRoot: this.workspaceRoot,
      ignore: this.ignore,
      maxFileBytes: this.config.maxFileBytes,
      blobs: this.store.blobs,
      ownershipFor: (rel) => {
        const base = baseline?.entries.find((e) => e.path === rel);
        return base?.ownership ?? ownership;
      },
    });
    return {
      id: newId("scan"),
      createdAt: nowIso(),
      root: this.workspaceRoot,
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
      provider: scanned.git ? "git+file" : "file",
    };
  }

  private async persistSnapshot(snapshot: WorkspaceSnapshot): Promise<void> {
    this.store.saveSnapshot({
      id: snapshot.id,
      createdAt: snapshot.createdAt,
      provider: snapshot.provider,
      gitJson: snapshot.git ? JSON.stringify(snapshot.git) : undefined,
      entries: snapshot.entries,
    });
  }

  private async loadSnapshotOrThrow(checkpointId: string): Promise<WorkspaceSnapshot> {
    const cp = this.requireCheckpoint(checkpointId);
    const stored = this.store.loadSnapshot(cp.workspaceSnapshot.id);
    if (!stored) {
      throw new TimeMachineError("CHECKPOINT_CORRUPTED", `Missing snapshot blob index for ${checkpointId}`);
    }
    return {
      id: stored.id,
      createdAt: stored.createdAt,
      root: this.workspaceRoot,
      entries: stored.entries,
      git: stored.gitJson ? (JSON.parse(stored.gitJson) as WorkspaceSnapshot["git"]) : undefined,
      provider: stored.provider,
    };
  }

  private async verifySnapshotIntegrity(snapshot: WorkspaceSnapshot): Promise<void> {
    for (const entry of snapshot.entries) {
      if (entry.type === "file" && entry.hash) {
        await this.store.blobs.verify(entry.hash);
      }
    }
  }

  private requireCheckpoint(id: string): TimeMachineCheckpoint {
    const short = this.store.listCheckpoints().find((c) => c.id === id || c.id.startsWith(id) || (c.label ?? "") === id);
    const cp = short ?? this.store.getCheckpoint(id);
    if (!cp) throw new TimeMachineError("CHECKPOINT_NOT_FOUND", `Unknown checkpoint ${id}`);
    return cp;
  }

  private latestReady(): TimeMachineCheckpoint | undefined {
    return [...this.list()].reverse().find((c) => c.status === "ready");
  }

  private placeholderCheckpoint(
    input: {
      reason: TimeMachineCheckpoint["reason"];
      label?: string;
      sessionId?: string;
      metadata?: Record<string, unknown>;
    },
    creating: boolean,
    warning?: string,
  ): TimeMachineCheckpoint {
    return {
      id: newId("cp"),
      sessionId: input.sessionId ?? this.sessionId,
      createdAt: nowIso(),
      reason: input.reason,
      label: input.label,
      workspaceSnapshot: { id: "pending", kind: "file", fileCount: 0, byteCount: 0 },
      sessionBoundary: { sessionId: input.sessionId ?? this.sessionId, coherent: false },
      sideEffectCursor: this.store.sideEffectCursor(),
      restorable: false,
      restoreLevel: "partial",
      warnings: warning ? [warning] : [],
      metadata: input.metadata ?? {},
      status: creating ? "creating" : "invalid",
      branchId: "main",
      pinned: false,
      knownGood: false,
    };
  }

  private async shouldSuggestGitignore(): Promise<boolean> {
    if (!this.config.suggestGitignore) return false;
    if (this.dataDir.startsWith(this.workspaceRoot)) {
      try {
        await access(join(this.workspaceRoot, ".gitignore"));
        const { readFile } = await import("node:fs/promises");
        const text = await readFile(join(this.workspaceRoot, ".gitignore"), "utf8");
        return !text.includes(".dsh-time-machine");
      } catch {
        return true;
      }
    }
    return false;
  }

  private async pruneIfNeeded(): Promise<void> {
    const policy = this.config.checkpoints;
    const all = this.store.listCheckpoints().filter((c) => c.status !== "pruned");
    const usage = await this.store.blobs.usageBytes();
    const overCount = all.length > policy.maxCheckpoints;
    const overBytes = usage > policy.maxStorageMB * 1024 * 1024;
    if (!overCount && !overBytes) return;
    const victims = [...all]
      .filter((c) => !c.pinned && c.reason !== "pre-restore")
      .sort((a, b) => checkpointRetentionScore(a) - checkpointRetentionScore(b));
    while (
      (this.store.listCheckpoints().filter((c) => c.status !== "pruned").length > policy.maxCheckpoints ||
        (await this.store.blobs.usageBytes()) > policy.maxStorageMB * 1024 * 1024) &&
      victims.length
    ) {
      const v = victims.shift();
      if (!v) break;
      v.status = "pruned";
      v.restorable = false;
      this.store.saveCheckpoint(v);
      this.store.appendLedger("timemachine/checkpoint-pruned", { id: v.id });
    }
    const live = this.store.referencedBlobHashes();
    // orphan blob GC is best-effort and only removes unreferenced hashes
    void live;
  }

  close(): void {
    this.store.close();
  }
}

function sigMap(entries: FileEntry[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const e of entries) {
    if (e.type === "directory") continue;
    map.set(e.path, fileSignature(e));
  }
  return map;
}

function normalizeExpected(root: string, paths: string[]): string[] {
  return paths.map((p) => {
    try {
      if (p.startsWith(root)) return toPosixRel(relative(root, p));
      return toPosixRel(p.replace(/^\.?\//, ""));
    } catch {
      return p.replaceAll("\\", "/").replace(/^\.?\//, "");
    }
  });
}

export function formatPreview(preview: RestorePreview): string {
  const lines = [
    `RESTORE CHECKPOINT ${preview.checkpointId}${preview.label ? ` (${preview.label})` : ""}`,
    "",
    "Will restore:",
    `  ${preview.willRestore.modified.length} modified files`,
    `  ${preview.willRestore.deleted.length} deleted files`,
    `  ${preview.willRestore.created.length} created files`,
    "",
    "Will preserve:",
    `  ${preview.willPreserve.length} pre-existing / protected paths`,
    "",
    "Session:",
    preview.session.canFork
      ? `  fork from seq ${preview.session.atSeq ?? "?"}`
      : `  cannot fork (${preview.session.reason ?? "incoherent boundary"})`,
    "",
    "External side effects:",
  ];
  if (preview.externalEffects.length === 0) lines.push("  none recorded");
  for (const e of preview.externalEffects) {
    const mark =
      e.reversibility === "irreversible" ? "✕" : e.reversibility === "unknown" ? "?" : "⚠";
    lines.push(`  ${mark} ${e.summary}`);
  }
  lines.push("", `Restore level: ${preview.restoreLevel.toUpperCase()}`);
  if (preview.conflicts.length) {
    lines.push("", "CONFLICTS:");
    for (const c of preview.conflicts) lines.push(`  ${c.path}: ${c.message}`);
  }
  for (const w of preview.warnings) lines.push(`  note: ${w}`);
  return lines.join("\n");
}

// type-only re-export path used above is value-imported in forkSession
export type { ApprovalPort as HarnessApprovalAdapter };
