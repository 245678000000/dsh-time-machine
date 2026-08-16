export type TimeMachineErrorCode =
  | "PATH_ESCAPE"
  | "SYMLINK_ESCAPE"
  | "PATH_TRAVERSAL"
  | "CHECKPOINT_NOT_FOUND"
  | "CHECKPOINT_NOT_READY"
  | "CHECKPOINT_CORRUPTED"
  | "RESTORE_BUSY"
  | "RESTORE_CONFLICT"
  | "RESTORE_PARTIAL"
  | "RESTORE_FAILED"
  | "UNSAFE_BOUNDARY"
  | "FORK_UNAVAILABLE"
  | "SESSION_ADAPTER_MISSING"
  | "APPROVAL_REQUIRED"
  | "APPROVAL_DENIED"
  | "WORKSPACE_LOCK_FAILED"
  | "QUOTA_EXCEEDED"
  | "INVALID_CONFIG";

export class TimeMachineError extends Error {
  readonly code: TimeMachineErrorCode;
  readonly details: Record<string, unknown>;

  constructor(
    code: TimeMachineErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "TimeMachineError";
    this.code = code;
    this.details = details;
  }
}
