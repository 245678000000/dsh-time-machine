import { TimeMachineError } from "../../domain/errors.ts";
import type { HarnessContext, HarnessSession, HarnessSessionAdapter } from "./types.ts";

export type { HarnessSessionAdapter };

/**
 * Reuses official SessionStore.fork / session.fork semantics.
 * Does not copy or rewrite parent history.
 */
export class OfficialSessionAdapter implements HarnessSessionAdapter {
  constructor(private readonly ctx: HarnessContext) {}

  async fork(input: { sessionId: string; atSeq?: number }): Promise<{ sessionId: string }> {
    const sessions = this.ctx.sessions ?? (this.ctx.get?.("sessions") as HarnessContext["sessions"]);
    if (!sessions?.fork) {
      throw new TimeMachineError(
        "SESSION_ADAPTER_MISSING",
        "Official Harness session.fork is not available in this composition. Workspace restore can still proceed.",
        { sessionId: input.sessionId },
      );
    }
    const source = { id: input.sessionId } as HarnessSession;
    const child = sessions.fork(source, input.atSeq);
    return { sessionId: child.id };
  }
}

export class RecordingSessionAdapter implements HarnessSessionAdapter {
  last?: { sessionId: string; atSeq?: number; childId: string };

  async fork(input: { sessionId: string; atSeq?: number }): Promise<{ sessionId: string }> {
    const childId = `${input.sessionId}~fork~${input.atSeq ?? "tail"}`;
    this.last = { ...input, childId };
    return { sessionId: childId };
  }
}
