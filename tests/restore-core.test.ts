import { describe, expect, it } from "vitest";
import { agentDelete, agentEdit, cleanup, exists, gitInit, openEngine, read, tempWorkspace, write } from "./helpers.ts";

describe("workspace restore", () => {
  it("restores an agent modification of one tracked file", async () => {
    const { root, data } = await tempWorkspace();
    try {
      await gitInit(root);
      await write(root, "src/app.ts", "ok\n");
      const engine = await openEngine(root, data);
      await engine.ensureBaseline();
      const start = engine.list().at(-1)!;
      await agentEdit(engine, root, "src/app.ts", "broken\n");
      expect(await read(root, "src/app.ts")).toBe("broken\n");
      const result = await engine.restore(start.id, { approved: true, mode: "workspace-only" });
      expect(result.status).toBe("success");
      expect(await read(root, "src/app.ts")).toBe("ok\n");
      engine.close();
    } finally {
      await cleanup([root, data]);
    }
  });

  it("removes an agent-created file", async () => {
    const { root, data } = await tempWorkspace();
    try {
      await write(root, "keep.txt", "keep");
      const engine = await openEngine(root, data);
      await engine.ensureBaseline();
      const start = engine.list().at(-1)!;
      await agentEdit(engine, root, "agent-new.txt", "new");
      expect(await exists(root, "agent-new.txt")).toBe(true);
      const result = await engine.restore(start.id, { approved: true, mode: "workspace-only" });
      expect(result.status).toBe("success");
      expect(await exists(root, "agent-new.txt")).toBe(false);
      expect(await read(root, "keep.txt")).toBe("keep");
      engine.close();
    } finally {
      await cleanup([root, data]);
    }
  });

  it("restores an agent-deleted file", async () => {
    const { root, data } = await tempWorkspace();
    try {
      await write(root, "victim.txt", "alive");
      const engine = await openEngine(root, data);
      await engine.ensureBaseline();
      const start = engine.list().at(-1)!;
      await agentDelete(engine, root, "victim.txt");
      expect(await exists(root, "victim.txt")).toBe(false);
      const result = await engine.restore(start.id, { approved: true, mode: "workspace-only" });
      expect(result.status).toBe("success");
      expect(await read(root, "victim.txt")).toBe("alive");
      engine.close();
    } finally {
      await cleanup([root, data]);
    }
  });

  it("preserves pre-existing uncommitted user edits on other files", async () => {
    const { root, data } = await tempWorkspace();
    try {
      await gitInit(root);
      await write(root, "src/app.ts", "orig\n");
      await write(root, "thesis.md", "user draft\n");
      const engine = await openEngine(root, data);
      await engine.ensureBaseline();
      const start = engine.list().at(-1)!;
      await agentEdit(engine, root, "src/app.ts", "agent broke it\n");
      const result = await engine.restore(start.id, { approved: true, mode: "workspace-only" });
      expect(result.status).toBe("success");
      expect(await read(root, "src/app.ts")).toBe("orig\n");
      expect(await read(root, "thesis.md")).toBe("user draft\n");
      expect(result.preservedPaths.includes("thesis.md") || (await read(root, "thesis.md")) === "user draft\n").toBe(true);
      engine.close();
    } finally {
      await cleanup([root, data]);
    }
  });

  it("restores a shared file to the pre-agent user version, not git HEAD", async () => {
    const { root, data } = await tempWorkspace();
    try {
      await gitInit(root);
      await write(root, "notes.txt", "committed\n");
      const { spawnSync } = await import("node:child_process");
      spawnSync("git", ["add", "notes.txt"], { cwd: root });
      spawnSync("git", ["commit", "-m", "base"], { cwd: root });
      await write(root, "notes.txt", "user uncommitted\n");
      const engine = await openEngine(root, data);
      await engine.ensureBaseline();
      const start = engine.list().at(-1)!;
      await agentEdit(engine, root, "notes.txt", "agent overwrite\n");
      expect(await read(root, "notes.txt")).toBe("agent overwrite\n");
      const result = await engine.restore(start.id, { approved: true, mode: "workspace-only" });
      expect(result.status).toBe("success");
      expect(await read(root, "notes.txt")).toBe("user uncommitted\n");
      engine.close();
    } finally {
      await cleanup([root, data]);
    }
  });

  it("does not delete a pre-existing untracked user file", async () => {
    const { root, data } = await tempWorkspace();
    try {
      await write(root, "draft.txt", "mine");
      const engine = await openEngine(root, data);
      await engine.ensureBaseline();
      const start = engine.list().at(-1)!;
      await agentEdit(engine, root, "src/x.ts", "x");
      await engine.restore(start.id, { approved: true, mode: "workspace-only" });
      expect(await read(root, "draft.txt")).toBe("mine");
      engine.close();
    } finally {
      await cleanup([root, data]);
    }
  });
});
