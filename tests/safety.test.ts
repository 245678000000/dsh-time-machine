import { describe, expect, it } from "vitest";
import { TimeMachineError } from "../src/domain/errors.ts";
import { assertRelativeSafe, resolveInsideWorkspace, resolveWorkspaceRoot } from "../src/paths/workspace-path.ts";
import { agentEdit, cleanup, openEngine, tempWorkspace, write } from "./helpers.ts";
import { symlink } from "node:fs/promises";
import { join } from "node:path";

describe("path safety", () => {
  it("rejects path traversal metadata", () => {
    expect(() => assertRelativeSafe("../../etc/passwd")).toThrow(TimeMachineError);
    expect(() => assertRelativeSafe("/etc/passwd")).toThrow(TimeMachineError);
  });

  it("rejects restore path escape via ..", async () => {
    const root = await resolveWorkspaceRoot(process.cwd());
    await expect(resolveInsideWorkspace(root, "../outside.txt")).rejects.toBeInstanceOf(TimeMachineError);
  });

  it("refuses snapshot/restore of a symlink that escapes the workspace", async () => {
    const { root, data } = await tempWorkspace();
    try {
      await write(root, "ok.txt", "ok");
      await symlink("/etc/passwd", join(root, "escape"));
      const engine = await openEngine(root, data);
      await engine.ensureBaseline();
      const snap = engine.store.loadSnapshot(engine.list().at(-1)!.workspaceSnapshot.id);
      expect(snap?.entries.some((e) => e.path === "escape")).toBe(false);
      engine.close();
    } finally {
      await cleanup([root, data]);
    }
  });

  it("refuses a corrupted checkpoint whose blob hash no longer matches", async () => {
    const { root, data } = await tempWorkspace();
    try {
      await write(root, "a.txt", "hello");
      const engine = await openEngine(root, data);
      await engine.ensureBaseline();
      const cp = engine.list().at(-1)!;
      const stored = engine.store.loadSnapshot(cp.workspaceSnapshot.id)!;
      const file = stored.entries.find((e) => e.path === "a.txt");
      expect(file?.hash).toBeTruthy();
      const dest = engine.store.blobs.pathFor(file!.hash!);
      const { writeFile } = await import("node:fs/promises");
      await writeFile(dest, "tampered");
      await expect(engine.previewRestore(cp.id)).rejects.toMatchObject({ code: "CHECKPOINT_CORRUPTED" });
      engine.close();
    } finally {
      await cleanup([root, data]);
    }
  });

  it("creates an emergency checkpoint before restore", async () => {
    const { root, data } = await tempWorkspace();
    try {
      await write(root, "a.txt", "one");
      const engine = await openEngine(root, data);
      await engine.ensureBaseline();
      const start = engine.list().at(-1)!;
      await agentEdit(engine, root, "a.txt", "two");
      const result = await engine.restore(start.id, { approved: true, mode: "workspace-only" });
      expect(result.emergencyCheckpointId).toBeTruthy();
      const emergency = engine.list().find((c) => c.id === result.emergencyCheckpointId);
      expect(emergency?.reason).toBe("pre-restore");
      expect(emergency?.pinned).toBe(true);
      engine.close();
    } finally {
      await cleanup([root, data]);
    }
  });

  it("detects concurrent external edits as restore conflicts", async () => {
    const { root, data } = await tempWorkspace();
    try {
      await write(root, "shared.txt", "base");
      const engine = await openEngine(root, data);
      await engine.ensureBaseline();
      const start = engine.list().at(-1)!;
      await agentEdit(engine, root, "shared.txt", "agent");
      await write(root, "shared.txt", "user raced");
      await expect(
        engine.restore(start.id, { approved: true, mode: "workspace-only" }),
      ).rejects.toMatchObject({ code: "RESTORE_CONFLICT" });
      expect(await (await import("node:fs/promises")).readFile(join(root, "shared.txt"), "utf8")).toBe("user raced");
      engine.close();
    } finally {
      await cleanup([root, data]);
    }
  });
});
