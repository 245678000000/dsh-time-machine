import type { SessionBoundaryRef } from "../domain/types.ts";

export interface SessionEventLike {
  type: string;
  seq: number;
}

/**
 * Official session.fork cut (deepseek-ai/deepseek-harness @ 47f9438):
 * atSeq anchors the first turn/end at or after it. The seed extends through
 * trailing out-of-band events until the next turn/start. A mid-turn or
 * dangling tool call is not a coherent restore/fork boundary.
 */
export function deriveSessionBoundary(input: {
  sessionId: string;
  events?: SessionEventLike[];
  atSeq?: number;
  openTurn?: boolean;
  openTool?: boolean;
}): SessionBoundaryRef {
  if (input.openTurn || input.openTool) {
    return {
      sessionId: input.sessionId,
      atSeq: input.atSeq,
      coherent: false,
      reason: "Checkpoint refused a coherent fork: turn or tool call is still open.",
    };
  }
  const events = input.events ?? [];
  if (events.length === 0) {
    return {
      sessionId: input.sessionId,
      atSeq: input.atSeq,
      coherent: input.atSeq !== undefined,
      lastTurnEndSeq: input.atSeq,
      reason: input.atSeq === undefined ? "No session events observed; fork adapter must supply atSeq." : undefined,
    };
  }
  const lastSeq = events.at(-1)?.seq ?? -1;
  const anchored =
    input.atSeq === undefined
      ? undefined
      : events.find((e) => e.type === "turn/end" && e.seq >= input.atSeq!);
  const boundary =
    anchored ??
    (input.atSeq === undefined || input.atSeq > lastSeq
      ? [...events].reverse().find((e) => e.type === "turn/end")
      : undefined);
  if (!boundary) {
    return {
      sessionId: input.sessionId,
      atSeq: input.atSeq,
      coherent: false,
      reason:
        input.atSeq !== undefined && input.atSeq <= lastSeq
          ? `Session has not completed the turn containing event ${input.atSeq}.`
          : "Session has no completed turn to fork from.",
    };
  }
  return {
    sessionId: input.sessionId,
    atSeq: boundary.seq,
    lastTurnEndSeq: boundary.seq,
    coherent: true,
  };
}

export function isSafeRestorePoint(boundary: SessionBoundaryRef, openTool: boolean): boolean {
  return boundary.coherent && !openTool;
}
