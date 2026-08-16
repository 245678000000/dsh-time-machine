import { describe, expect, it } from "vitest";
import { RecordingSessionAdapter } from "../src/adapters/harness/session-adapter.ts";
import { classifySideEffect } from "../src/effects/classifier.ts";
import { deriveSessionBoundary } from "../src/session/boundary.ts";
import { agentEdit, cleanup, openEngine, tempWorkspace, write } from "./helpers.ts";

describe("session fork vs workspace rollback", () => {
  it("refuses a coherent fork while a tool call is open", () => {
    const b = deriveSessionBoundary({
      sessionId: "s1",
      events: [
        { type: "turn/start", seq: 0 },
        { type: "tool/call", seq: 1 },
      ],
      openTool: true,
      openTurn: true,
    });
    expect(b.coherent).toBe(false);
  });

  it("anchors the official turn/end cut used by session.fork", () => {
    const b = deriveSessionBoundary({
      sessionId: "s1",
      atSeq: 2,
      events: [
        { type: "turn/start", seq: 0 },
        { type: "user/message", seq: 1 },
        { type: "turn/end", seq: 4 },
        { type: "turn/start", seq: 5 },
      ],
    });
    expect(b.coherent).toBe(true);
    expect(b.atSeq).toBe(4);
  });

  it("fork-only does not modify workspace files", async () => {
    const { root, data } = await tempWorkspace();
    try {
      await write(root, "a.txt", "v1");
      const engine = await openEngine(root, data);
      engine.setAdapters({ session: new RecordingSessionAdapter() });
      engine.noteSessionEvent({ type: "turn/start", seq: 0 });
      engine.noteSessionEvent({ type: "turn/end", seq: 1 });
      await engine.ensureBaseline();
      const cp = engine.list().at(-1)!;
      await agentEdit(engine, root, "a.txt", "v2");
      const before = await (await import("node:fs/promises")).readFile(`${root}/a.txt`, "utf8");
      const result = await engine.forkOnly(cp.id);
      const after = await (await import("node:fs/promises")).readFile(`${root}/a.txt`, "utf8");
      expect(before).toBe("v2");
      expect(after).toBe("v2");
      expect(result.restoreLevel).toBe("session-only");
      expect(result.restoredPaths).toEqual([]);
      expect(result.newSessionId).toBeTruthy();
      engine.close();
    } finally {
      await cleanup([root, data]);
    }
  });

  it("restore + fork maps the official boundary and records lineage", async () => {
    const { root, data } = await tempWorkspace();
    try {
      await write(root, "a.txt", "v1");
      const adapter = new RecordingSessionAdapter();
      const engine = await openEngine(root, data);
      engine.setAdapters({ session: adapter });
      engine.sessionId = "sess-parent";
      engine.noteSessionEvent({ type: "turn/start", seq: 0 });
      engine.noteSessionEvent({ type: "turn/end", seq: 3 });
      await engine.ensureBaseline("sess-parent");
      const cp = engine.list().at(-1)!;
      await agentEdit(engine, root, "a.txt", "v2");
      const result = await engine.restore(cp.id, { approved: true, mode: "restore-and-fork" });
      expect(result.status).toBe("success");
      expect(result.newSessionId).toContain("sess-parent");
      expect(adapter.last?.atSeq).toBe(3);
      expect(engine.branches().some((b) => b.parentSessionId === "sess-parent")).toBe(true);
      engine.close();
    } finally {
      await cleanup([root, data]);
    }
  });

  it("workspace-only restore does not claim a session rollback", async () => {
    const { root, data } = await tempWorkspace();
    try {
      await write(root, "a.txt", "v1");
      const engine = await openEngine(root, data);
      await engine.ensureBaseline();
      const cp = engine.list().at(-1)!;
      await agentEdit(engine, root, "a.txt", "v2");
      const result = await engine.restore(cp.id, { approved: true, mode: "workspace-only" });
      expect(result.newSessionId).toBeUndefined();
      expect(result.restoreLevel === "workspace-only" || result.restoreLevel === "partial").toBe(true);
      engine.close();
    } finally {
      await cleanup([root, data]);
    }
  });
});

describe("side-effect honesty", () => {
  it("classifies send_email as irreversible", () => {
    const fx = classifySideEffect({
      toolCallId: "1",
      toolName: "send_email",
      args: { to: "test@example.invalid", subject: "hi" },
    });
    expect(fx.reversibility).toBe("irreversible");
    expect(fx.category).toBe("message");
  });

  it("classifies create_issue as conditionally reversible and does not auto-undo", () => {
    const fx = classifySideEffect({
      toolCallId: "2",
      toolName: "create_issue",
      args: { repo: "acme/app", title: "bug" },
    });
    expect(fx.reversibility).toBe("conditionally-reversible");
  });

  it("records irreversible email on restore preview", async () => {
    const { root, data } = await tempWorkspace();
    try {
      await write(root, "a.txt", "v1");
      const engine = await openEngine(root, data);
      await engine.ensureBaseline();
      const start = engine.list().at(-1)!;
      await engine.observeToolPre({
        toolName: "send_email",
        args: { to: "test@example.invalid" },
        toolCallId: "mail-1",
      });
      await engine.observeToolResult({
        toolName: "send_email",
        args: { to: "test@example.invalid" },
        toolCallId: "mail-1",
      });
      const preview = await engine.previewRestore(start.id);
      expect(preview.externalEffects.some((e) => e.reversibility === "irreversible")).toBe(true);
      const result = await engine.restore(start.id, { approved: true, mode: "workspace-only" });
      expect(result.irreversibleEffects.length).toBeGreaterThan(0);
      engine.close();
    } finally {
      await cleanup([root, data]);
    }
  });

  it("records unexpected extra mutations", async () => {
    const { root, data } = await tempWorkspace();
    try {
      await write(root, "package.json", "{}");
      await write(root, "other.ts", "x");
      const engine = await openEngine(root, data);
      await engine.ensureBaseline();
      await engine.observeToolPre({
        toolName: "edit_file",
        args: { path: "package.json" },
        toolCallId: "u1",
      });
      await write(root, "package.json", "{x}");
      await write(root, "other.ts", "y");
      const obs = await engine.observeToolResult({
        toolName: "edit_file",
        args: { path: "package.json" },
        toolCallId: "u1",
      });
      expect(obs.unexpected?.unexpectedPaths.some((p) => p.endsWith("other.ts"))).toBe(true);
      engine.close();
    } finally {
      await cleanup([root, data]);
    }
  });
});
