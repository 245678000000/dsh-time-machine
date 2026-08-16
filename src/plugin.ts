import { OfficialApprovalAdapter } from "./adapters/harness/approval-adapter.ts";
import { OfficialSessionAdapter } from "./adapters/harness/session-adapter.ts";
import type { HarnessContext, HarnessToolExecution, PreToolDecision } from "./adapters/harness/types.ts";
import { TimeMachineEngine } from "./engine.ts";
import { timeMachineToolDefinitions } from "./tools/time-machine-tools.ts";
import type { TimeMachineConfig } from "./domain/types.ts";
import { DEFAULT_CHECKPOINT_POLICY } from "./domain/types.ts";

export const name = "dsh-time-machine";
export const inject: string[] = [];

export interface PluginConfig {
  workspaceRoot?: string;
  dataDir?: string;
  checkpoints?: Partial<TimeMachineConfig["checkpoints"]>;
  validation?: TimeMachineConfig["validation"];
  maxFileBytes?: number;
  requireRestoreApproval?: boolean;
}

export const Config = {
  workspaceRoot: { type: "string" },
  dataDir: { type: "string" },
};

let singleton: TimeMachineEngine | undefined;

export function getEngine(): TimeMachineEngine | undefined {
  return singleton;
}

export async function apply(ctx: HarnessContext, config: PluginConfig = {}): Promise<void> {
  const workspaceRoot =
    config.workspaceRoot ??
    (typeof process.env.DSH_WORKSPACE === "string" ? process.env.DSH_WORKSPACE : process.cwd());

  const engine = await TimeMachineEngine.open({
    workspaceRoot,
    dataDir: config.dataDir,
    checkpoints: { ...DEFAULT_CHECKPOINT_POLICY, ...config.checkpoints },
    validation: config.validation,
    maxFileBytes: config.maxFileBytes,
    requireRestoreApproval: config.requireRestoreApproval,
  });
  singleton = engine;

  if (ctx.sessions ?? ctx.get?.("sessions")) {
    engine.setAdapters({
      session: new OfficialSessionAdapter(ctx),
      approval: ctx.approval ?? ctx.get?.("approval") ? new OfficialApprovalAdapter(ctx) : undefined,
    });
  }

  const tools = ctx.tools ?? (ctx.get?.("tools") as HarnessContext["tools"]);
  if (tools?.register) {
    for (const def of timeMachineToolDefinitions(engine)) {
      tools.register(def);
    }
  }

  ctx.on?.("agent/session-start", async (...args: unknown[]) => {
    const session = firstSession(args);
    if (session) engine.sessionId = session;
    await engine.ensureBaseline(engine.sessionId);
  });

  ctx.on?.("session/event", (...args: unknown[]) => {
    const event = args.find((a) => a && typeof a === "object" && "type" in (a as object) && "seq" in (a as object)) as
      | { type: string; seq: number }
      | undefined;
    if (event) engine.noteSessionEvent(event);
  });

  ctx.on?.("tools/pre-execute", async (execUnknown, nextUnknown) => {
    const exec = execUnknown as HarnessToolExecution;
    const next = nextUnknown as () => Promise<PreToolDecision>;
    try {
      await engine.observeToolPre({
        toolName: exec.name,
        args: exec.arguments,
        toolCallId: String(exec.callId ?? exec.token ?? exec.name),
        sessionId: exec.agent?.session?.id,
        agentId: exec.agent?.session?.id,
      });
    } catch {
      // observation must not deny the call; policy lives elsewhere
    }
    return next();
  });

  ctx.on?.("tools/result", (...args: unknown[]) => {
    const exec = args[0] as HarnessToolExecution | undefined;
    const result = args[1] as { isError?: boolean; value?: unknown } | undefined;
    if (!exec) return;
    void engine.observeToolResult({
      toolName: exec.name,
      args: exec.arguments,
      toolCallId: String(exec.callId ?? exec.token ?? exec.name),
      sessionId: exec.agent?.session?.id,
      result: result?.value,
      isError: result?.isError,
    });
  });

  ctx.on?.("fs/observed", (...args: unknown[]) => {
    const target = args[0] as { path?: string } | undefined;
    if (target?.path) {
      engine.noteSessionEvent({ type: "fs/observed", seq: Date.now() });
    }
  });

  ctx.provide?.("timeMachine", engine);
}

function firstSession(args: unknown[]): string | undefined {
  for (const a of args) {
    if (typeof a === "string") return a;
    if (a && typeof a === "object" && "id" in a && typeof (a as { id: unknown }).id === "string") {
      return (a as { id: string }).id;
    }
    if (a && typeof a === "object" && "session" in a) {
      const s = (a as { session?: { id?: string } }).session;
      if (s?.id) return s.id;
    }
  }
  return undefined;
}

export default {
  name,
  inject,
  apply,
  Config,
};
