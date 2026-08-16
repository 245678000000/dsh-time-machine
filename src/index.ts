export { TimeMachineEngine, formatPreview } from "./engine.ts";
export { TimeMachineError } from "./domain/errors.ts";
export type {
  TimeMachineCheckpoint,
  TimeMachineConfig,
  RestoreResult,
  RestorePreview,
  SideEffectRecord,
  MutationRecord,
  WorkspaceBaseline,
  TimeMachineSideEffectDescriptor,
  UndoAdapter,
  RiskSignalProvider,
  CheckpointPolicy,
} from "./domain/types.ts";
export { DEFAULT_CHECKPOINT_POLICY } from "./domain/types.ts";
export { classifySideEffect, basicRisk } from "./effects/classifier.ts";
export { deriveSessionBoundary } from "./session/boundary.ts";
export { CheckpointStore, defaultDataDir } from "./storage/store.ts";
export { BlobStore } from "./storage/blob-store.ts";
export {
  name as pluginName,
  apply as applyPlugin,
  getEngine,
} from "./plugin.ts";
export { OfficialSessionAdapter, RecordingSessionAdapter } from "./adapters/harness/session-adapter.ts";
export { OfficialApprovalAdapter } from "./adapters/harness/approval-adapter.ts";
export { timeMachineToolDefinitions } from "./tools/time-machine-tools.ts";
