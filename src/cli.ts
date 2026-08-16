#!/usr/bin/env node
import { resolve } from "node:path";
import { formatPreview, TimeMachineEngine } from "./engine.ts";
import type { RestoreOptions, TimeMachineCheckpoint } from "./domain/types.ts";

function arg(flag: string, argv: string[]): string | undefined {
  const i = argv.indexOf(flag);
  if (i === -1) return undefined;
  return argv[i + 1];
}

function has(flag: string, argv: string[]): boolean {
  return argv.includes(flag);
}

function print(value: unknown): void {
  if (typeof value === "string") {
    process.stdout.write(`${value}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function formatList(cps: TimeMachineCheckpoint[]): string {
  if (cps.length === 0) return "(no checkpoints)";
  return cps
    .map((c) => {
      const star = c.knownGood ? " ★ GOOD" : "";
      const pin = c.pinned ? " PIN" : "";
      const warn = c.warnings.some((w) => w.includes("side")) ? " ⚠" : "";
      return `${c.id}  ${c.status.padEnd(8)}  ${c.reason.padEnd(20)}  ${(c.label ?? "").slice(0, 40)}${star}${pin}${warn}`;
    })
    .join("\n");
}

async function main(argv: string[]): Promise<number> {
  const cmd = argv[0] ?? "help";
  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    print(helpText());
    return 0;
  }

  const workspace = resolve(arg("--workspace", argv) ?? process.cwd());
  const dataDir = arg("--data-dir", argv);
  const engine = await TimeMachineEngine.open({
    workspaceRoot: workspace,
    dataDir,
    requireRestoreApproval: !has("--yes", argv),
  });

  try {
    switch (cmd) {
      case "status": {
        const s = await engine.status();
        print(renderStatus(s));
        return 0;
      }
      case "init":
      case "baseline": {
        await engine.ensureBaseline();
        print(await engine.status());
        return 0;
      }
      case "checkpoint": {
        const label = argv.filter((a) => !a.startsWith("--")).slice(1).join(" ") || undefined;
        const cp = await engine.checkpoint({ reason: "manual", label, pinned: has("--pin", argv) });
        print(cp);
        return 0;
      }
      case "list": {
        print(formatList(engine.list()));
        return 0;
      }
      case "diff": {
        const id = argv[1];
        if (!id) return fail("usage: dsh-time-machine diff <checkpoint>");
        print(await engine.diff(id));
        return 0;
      }
      case "preview":
      case "preview-restore": {
        const id = argv[1];
        if (!id) return fail("usage: dsh-time-machine preview <checkpoint>");
        print(formatPreview(await engine.previewRestore(id)));
        return 0;
      }
      case "restore": {
        const id = argv[1];
        if (!id) return fail("usage: dsh-time-machine restore <checkpoint> [--yes] [--workspace-only|--fork-only]");
        const mode: RestoreOptions["mode"] = has("--fork-only", argv)
          ? "fork-only"
          : has("--workspace-only", argv)
            ? "workspace-only"
            : "restore-and-fork";
        if (!has("--yes", argv) && mode !== "fork-only") {
          print(formatPreview(await engine.previewRestore(id)));
          print("\nRe-run with --yes to apply after you have read the preview.");
          return 2;
        }
        const result = await engine.restore(id, { mode, approved: has("--yes", argv) });
        print(renderRestore(result));
        return result.status === "success" ? 0 : result.status === "partial" ? 3 : 1;
      }
      case "fork": {
        const id = argv[1];
        if (!id) return fail("usage: dsh-time-machine fork <checkpoint>");
        print(await engine.forkOnly(id));
        return 0;
      }
      case "effects": {
        print(engine.effects());
        return 0;
      }
      case "branches": {
        print(engine.branches());
        return 0;
      }
      case "pin": {
        const id = argv[1];
        if (!id) return fail("usage: dsh-time-machine pin <checkpoint>");
        print(await engine.pin(id, !has("--unpin", argv)));
        return 0;
      }
      case "validate": {
        print(await engine.validate(argv[1]));
        return 0;
      }
      case "known-good":
      case "restore-good": {
        if (!has("--yes", argv)) {
          const g = engine.lastKnownGood();
          print(g ? `Last known good: ${g.id} ${g.label ?? ""}\nRe-run with --yes to restore.` : "No known-good checkpoint.");
          return g ? 2 : 1;
        }
        print(renderRestore(await engine.restoreLastKnownGood({ approved: true })));
        return 0;
      }
      case "find-bad": {
        print(await engine.findFirstBad({ isolated: has("--isolated", argv) }));
        return 0;
      }
      case "ledger": {
        print(engine.ledger());
        return 0;
      }
      default:
        return fail(`unknown command ${cmd}\n\n${helpText()}`);
    }
  } finally {
    engine.close();
  }
}

function fail(message: string): number {
  process.stderr.write(`${message}\n`);
  return 1;
}

function helpText(): string {
  return `dsh-time-machine — Undo agent mistakes, not just conversations.

  Session fork ≠ workspace rollback.

Commands:
  status
  init
  checkpoint [label] [--pin]
  list
  diff <checkpoint>
  preview <checkpoint>
  restore <checkpoint> [--yes] [--workspace-only|--fork-only]
  fork <checkpoint>
  effects
  branches
  pin <checkpoint> [--unpin]
  validate [checkpoint]
  known-good [--yes]
  find-bad [--isolated]
  ledger

Options:
  --workspace <dir>   Workspace root (default: cwd)
  --data-dir <dir>    Time Machine data (default: ~/.dsh-time-machine/<id>)
  --yes               Approve a destructive restore after preview
`;
}

function renderStatus(s: Awaited<ReturnType<TimeMachineEngine["status"]>>): string {
  return [
    `Workspace: ${s.workspaceRoot}`,
    `Data:      ${s.dataDir}`,
    `Session:   ${s.sessionId}`,
    `Baseline:  ${s.baseline ? s.baseline.createdAt : "(none)"}`,
    `Checkpoints: ${s.checkpointCount}`,
    `Last:      ${s.lastCheckpoint ? `${s.lastCheckpoint.id} ${s.lastCheckpoint.label ?? ""}` : "(none)"}`,
    `Known good:${s.lastKnownGood ? ` ${s.lastKnownGood.id}` : " (none)"}`,
    `Irreversible effects: ${s.irreversibleEffects}`,
    s.gitignoreSuggested ? "Note: if you keep data inside the repo, add .dsh-time-machine to .gitignore (not modified automatically)." : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function renderRestore(r: Awaited<ReturnType<TimeMachineEngine["restore"]>>): string {
  const mark = r.status === "success" ? "SUCCESS" : r.status === "partial" ? "PARTIAL" : "FAILED";
  const lines = [
    `Restore: ${mark}`,
    `Checkpoint: ${r.checkpointId}`,
    `Level: ${r.restoreLevel}`,
    `Restored: ${r.restoredPaths.length}`,
    `Preserved: ${r.preservedPaths.length}`,
    `Failed: ${r.failedPaths.length}`,
    `Verification: ${r.verificationPassed ? "passed" : "failed"}`,
  ];
  if (r.newSessionId) lines.push(`Forked session: ${r.newSessionId}`);
  if (r.emergencyCheckpointId) lines.push(`Emergency CP: ${r.emergencyCheckpointId}`);
  if (r.irreversibleEffects.length) {
    lines.push("", "The following actions were NOT undone:");
    for (const e of r.irreversibleEffects) lines.push(`  ⚠ ${e.summary}`);
  }
  for (const w of r.warnings) lines.push(`note: ${w}`);
  for (const f of r.failedPaths) lines.push(`fail: ${f.path} (${f.reason})`);
  return lines.join("\n");
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
