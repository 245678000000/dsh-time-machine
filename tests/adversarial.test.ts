import { describe, expect, it } from "vitest";
import { applyRestorePlan } from "../src/restore/executor.ts";
import { BlobStore } from "../src/storage/blob-store.ts";
import { cleanup, openEngine, tempWorkspace, write } from "./helpers.ts";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

describe("adversarial restore honesty", () => {
  it("reports partial instead of success when a staged write cannot commit", async () => {
    const { root, data } = await tempWorkspace();
    try {
      const blobs = new BlobStore(join(data, "blobs"));
      const ref = await blobs.put(Buffer.from("hello"));
      // parent path is a file, so mkdir/write underneath must fail
      await write(root, "not-a-dir", "file");
      const result = await applyRestorePlan({
        workspaceRoot: root,
        checkpointId: "cp_x",
        writes: [
          {
            path: "ok.txt",
            type: "file",
            mode: 0o644,
            hash: ref.hash,
            size: ref.bytes,
            ownership: "agent",
          },
          {
            path: "not-a-dir/child.txt",
            type: "file",
            mode: 0o644,
            hash: ref.hash,
            size: ref.bytes,
            ownership: "agent",
          },
        ],
        deletes: [],
        preserves: [],
        blobs,
      });
      expect(result.status).not.toBe("success");
      expect(result.verificationPassed).toBe(false);
      expect(result.failedPaths.length).toBeGreaterThan(0);
    } finally {
      await cleanup([root, data]);
    }
  });

  it("does not treat replay as re-execution of destructive tools", async () => {
    const { root, data } = await tempWorkspace();
    try {
      await write(root, "a.txt", "1");
      const engine = await openEngine(root, data);
      await engine.ensureBaseline();
      await engine.observeToolPre({
        toolName: "send_email",
        args: { to: "test@example.invalid" },
        toolCallId: "r1",
      });
      await engine.observeToolResult({
        toolName: "send_email",
        args: { to: "test@example.invalid" },
        toolCallId: "r1",
      });
      const events = engine.ledger().map((e) => e.type);
      expect(events).toContain("timemachine/irreversible-action");
      expect(events).not.toContain("timemachine/restore-completed");
      engine.close();
    } finally {
      await cleanup([root, data]);
    }
  });

  it("never snapshots paths outside the workspace root", async () => {
    const { root, data } = await tempWorkspace();
    try {
      await mkdir(join(root, "src"), { recursive: true });
      await write(root, "src/in.txt", "in");
      const engine = await openEngine(root, data);
      await engine.ensureBaseline();
      const snap = engine.store.loadSnapshot(engine.list()[0]!.workspaceSnapshot.id)!;
      expect(snap.entries.every((e) => !e.path.startsWith("/") && !e.path.includes(".."))).toBe(true);
      engine.close();
    } finally {
      await cleanup([root, data]);
    }
  });
});
