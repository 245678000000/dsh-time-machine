import { describe, expect, it } from "vitest";
import { agentEdit, cleanup, openEngine, tempWorkspace, write } from "./helpers.ts";

describe("persistence, quota, known-good", () => {
  it("survives restart from the same data dir", async () => {
    const { root, data } = await tempWorkspace();
    try {
      await write(root, "a.txt", "one");
      const engine = await openEngine(root, data);
      await engine.ensureBaseline();
      const id = engine.list()[0]!.id;
      engine.close();
      const again = await openEngine(root, data);
      expect(again.list().some((c) => c.id === id)).toBe(true);
      expect(again.store.loadBaseline()?.entries.some((e) => e.path === "a.txt")).toBe(true);
      again.close();
    } finally {
      await cleanup([root, data]);
    }
  });

  it("dedupes identical blobs", async () => {
    const { root, data } = await tempWorkspace();
    try {
      await write(root, "a.txt", "same");
      await write(root, "b.txt", "same");
      const engine = await openEngine(root, data);
      await engine.ensureBaseline();
      const snap = engine.store.loadSnapshot(engine.list()[0]!.workspaceSnapshot.id)!;
      const ha = snap.entries.find((e) => e.path === "a.txt")?.hash;
      const hb = snap.entries.find((e) => e.path === "b.txt")?.hash;
      expect(ha).toBe(hb);
      engine.close();
    } finally {
      await cleanup([root, data]);
    }
  });

  it("prunes automatic checkpoints before pinned and known-good ones", async () => {
    const { root, data } = await tempWorkspace();
    try {
      await write(root, "a.txt", "0");
      const engine = await openEngine(root, data, {
        checkpoints: {
          onTaskStart: true,
          beforeDestructiveTool: false,
          beforeExternalAction: false,
          afterMutations: 1,
          maxCheckpoints: 3,
          maxStorageMB: 256,
        },
      });
      await engine.ensureBaseline();
      const first = engine.list()[0]!;
      await engine.pin(first.id, true);
      for (let i = 1; i <= 6; i += 1) {
        await agentEdit(engine, root, "a.txt", `v${i}`);
        await engine.checkpoint({ reason: "automatic", label: `auto-${i}` });
      }
      const live = engine.list();
      expect(live.length).toBeLessThanOrEqual(3);
      expect(live.some((c) => c.id === first.id)).toBe(true);
      engine.close();
    } finally {
      await cleanup([root, data]);
    }
  });

  it("marks a checkpoint known-good when validation passes", async () => {
    const { root, data } = await tempWorkspace();
    try {
      await write(root, "ok.txt", "ok");
      const engine = await openEngine(root, data, {
        validation: { commands: ["node -e \"process.exit(0)\""] },
      });
      await engine.ensureBaseline();
      const cp = await engine.validate();
      expect(cp?.knownGood).toBe(true);
      expect(engine.lastKnownGood()?.id).toBe(cp?.id);
      engine.close();
    } finally {
      await cleanup([root, data]);
    }
  });

  it("finds first stored failing checkpoint", async () => {
    const { root, data } = await tempWorkspace();
    try {
      await write(root, "t.txt", "1");
      const engine = await openEngine(root, data);
      await engine.ensureBaseline();
      const good = engine.list()[0]!;
      engine.store.updateValidation(
        good.id,
        { commands: ["test"], status: "pass", results: [], ranAt: new Date().toISOString() },
        true,
      );
      await agentEdit(engine, root, "t.txt", "2");
      const bad = await engine.checkpoint({ reason: "manual", label: "broke" });
      engine.store.updateValidation(
        bad.id,
        { commands: ["test"], status: "fail", results: [], ranAt: new Date().toISOString() },
        false,
      );
      const found = await engine.findFirstBad();
      expect(found.lastGood?.id).toBe(good.id);
      expect(found.firstBad?.id).toBe(bad.id);
      engine.close();
    } finally {
      await cleanup([root, data]);
    }
  });
});
