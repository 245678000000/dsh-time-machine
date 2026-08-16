/**
 * Duck-typed official DeepSeek Harness surfaces.
 * Shapes verified against deepseek-ai/deepseek-harness @ 47f943859bef60e4160492346772ded9b24f765a
 * (release dsh@0.1.0-rc.5). We do not reimplement session fork.
 */

export interface HarnessSessionEvent {
  type: string;
  seq: number;
  time?: number;
  data?: unknown;
}

export interface HarnessSession {
  id: string;
  events?: readonly HarnessSessionEvent[];
}

export interface HarnessSessionStore {
  fork?(source: HarnessSession, boundary?: number, childSessionId?: string): HarnessSession;
  create?(id: string, options?: { seed?: readonly HarnessSessionEvent[] }): HarnessSession | Promise<HarnessSession>;
}

export interface HarnessApproval {
  request?(req: {
    title: string;
    message: string;
    session?: unknown;
  }): Promise<{ kind: "allow" | "deny" | "cancelled" } | boolean>;
  setPolicy?(agent: unknown, policy: unknown): void;
}

export interface PreToolDecision {
  kind: "allow" | "deny" | "ask";
  reason?: string;
}

export interface HarnessToolExecution {
  name: string;
  arguments: unknown;
  callId?: string;
  token?: string;
  agent?: { session?: { id: string; events?: HarnessSessionEvent[] } };
  signal?: AbortSignal;
  parent?: unknown;
}

export interface HarnessToolResult {
  isError?: boolean;
  value?: unknown;
  content?: unknown;
}

export interface HarnessToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, exec: HarnessToolExecution) => Promise<unknown> | unknown;
}

export interface HarnessTools {
  register(def: HarnessToolDefinition | unknown): unknown;
}

export interface HarnessContext {
  tools?: HarnessTools;
  sessions?: HarnessSessionStore;
  approval?: HarnessApproval;
  on?(event: string, listener: (...args: unknown[]) => unknown): unknown;
  waterfall?: (...args: unknown[]) => unknown;
  get?(name: string): unknown;
  plugin?(value: unknown): unknown;
  provide?(name: string, value: unknown): unknown;
}

export interface HarnessSessionAdapter {
  fork(input: { sessionId: string; atSeq?: number }): Promise<{ sessionId: string }>;
}

export interface HarnessApprovalAdapter {
  requestRestoreApproval(previewText: string): Promise<boolean>;
}

export interface HarnessWorkspaceAdapter {
  root(): string | undefined;
}

export interface HarnessToolAdapter {
  registerTools(defs: HarnessToolDefinition[]): void;
}
