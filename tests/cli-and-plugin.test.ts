import { describe, expect, it } from "vitest";
import { apply, getEngine, name } from "../src/plugin.ts";
import { timeMachineToolDefinitions } from "../src/tools/time-machine-tools.ts";
import { cleanup, openEngine, tempWorkspace, write } from "./helpers.ts";
import type { HarnessContext } from "../src/adapters/harness/types.ts";

describe("plugin and tools", () => {
  it("exports the Cordis plugin name", () => {
    expect(name).toBe("dsh-time-machine");
  });

  it("loads via apply and registers tools without monkey-patching a loop", async () => {
    const { root, data } = await tempWorkspace();
    try {
      await write(root, "a.txt", "x");
      const registered: string[] = [];
      const events: string[] = [];
      const ctx: HarnessContext = {
        tools: {
          register(def) {
            const name = (def as { name: string }).name;
            registered.push(name);
          },
        },
        on(event, _listener) {
          events.push(event);
        },
        provide() {
          return undefined;
        },
      };
      await apply(ctx, { workspaceRoot: root, dataDir: data });
      expect(registered).toContain("time_machine_status");
      expect(registered).toContain("time_machine_restore");
      expect(events).toContain("tools/pre-execute");
      expect(events).toContain("tools/result");
      expect(getEngine()).toBeTruthy();
      getEngine()?.close();
    } finally {
      await cleanup([root, data]);
    }
  });

  it("exposes a bounded tool set", async () => {
    const { root, data } = await tempWorkspace();
    try {
      const engine = await openEngine(root, data);
      const defs = timeMachineToolDefinitions(engine);
      expect(defs.length).toBeLessThanOrEqual(10);
      expect(defs.map((d) => d.name)).toEqual([
        "time_machine_status",
        "time_machine_checkpoint",
        "time_machine_list",
        "time_machine_diff",
        "time_machine_preview_restore",
        "time_machine_restore",
        "time_machine_fork",
        "time_machine_branch",
        "time_machine_side_effects",
      ]);
      engine.close();
    } finally {
      await cleanup([root, data]);
    }
  });
});
