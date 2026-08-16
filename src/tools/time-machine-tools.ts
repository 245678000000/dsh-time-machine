import { formatPreview, type TimeMachineEngine } from "../engine.ts";
import type { HarnessToolDefinition, HarnessToolExecution } from "../adapters/harness/types.ts";

export function timeMachineToolDefinitions(engine: TimeMachineEngine): HarnessToolDefinition[] {
  const text = (value: unknown) => value;

  return [
    {
      name: "time_machine_status",
      description: "Show Time Machine workspace/session/side-effect status. Session fork is not workspace rollback.",
      parameters: {},
      execute: async () => text(await engine.status()),
    },
    {
      name: "time_machine_checkpoint",
      description: "Create a manual coherent checkpoint of workspace + session boundary + side-effect cursor.",
      parameters: {
        label: { type: "string", description: "Optional human label" },
      },
      execute: async (args) => {
        const label = typeof args.label === "string" ? args.label : undefined;
        return engine.checkpoint({ reason: "manual", label });
      },
    },
    {
      name: "time_machine_list",
      description: "List checkpoints, known-good marks, and restore levels.",
      parameters: {},
      execute: async () => engine.list(),
    },
    {
      name: "time_machine_diff",
      description: "Diff a checkpoint against the current workspace.",
      parameters: {
        checkpoint: { type: "string", required: true },
      },
      execute: async (args) => engine.diff(String(args.checkpoint)),
    },
    {
      name: "time_machine_preview_restore",
      description: "Preview a restore. Default before any restore. Does not write files.",
      parameters: {
        checkpoint: { type: "string", required: true },
      },
      execute: async (args) => {
        const preview = await engine.previewRestore(String(args.checkpoint));
        return { preview, text: formatPreview(preview) };
      },
    },
    {
      name: "time_machine_restore",
      description:
        "Restore workspace to a checkpoint after preview/approval. Does not claim to unsend email or roll back remote APIs. Use mode restore-and-fork (default), workspace-only, or fork-only.",
      parameters: {
        checkpoint: { type: "string", required: true },
        mode: { type: "string", description: "restore-and-fork | workspace-only | fork-only" },
        approved: { type: "boolean" },
      },
      execute: async (args, exec: HarnessToolExecution) => {
        void exec;
        const mode = parseMode(args.mode);
        return engine.restore(String(args.checkpoint), {
          mode,
          approved: Boolean(args.approved),
        });
      },
    },
    {
      name: "time_machine_fork",
      description: "Fork only the Harness session at the checkpoint boundary. Does not modify workspace files.",
      parameters: {
        checkpoint: { type: "string", required: true },
      },
      execute: async (args) => engine.forkOnly(String(args.checkpoint)),
    },
    {
      name: "time_machine_branch",
      description: "Show Time Machine branch lineage mapped onto official session parent/fork ids.",
      parameters: {},
      execute: async () => engine.branches(),
    },
    {
      name: "time_machine_side_effects",
      description: "List the side-effect ledger with honest reversibility. Time Machine does not invent external undo.",
      parameters: {},
      execute: async () => engine.effects(),
    },
  ];
}

function parseMode(value: unknown): "restore-and-fork" | "workspace-only" | "fork-only" {
  if (value === "workspace-only" || value === "fork-only" || value === "restore-and-fork") return value;
  return "restore-and-fork";
}
