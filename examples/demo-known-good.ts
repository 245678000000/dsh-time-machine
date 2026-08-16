/**
 * Killer demo 1 — restore last known good.
 *
 *   pnpm demo:known-good
 */
import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { TimeMachineEngine } from "../src/engine.ts";

async function write(root: string, rel: string, text: string) {
  const full = join(root, rel);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, text);
}

async function main() {
  const root = join(tmpdir(), `dsh-tm-demo-good-${Date.now()}`);
  const data = `${root}-data`;
  await mkdir(root, { recursive: true });
  spawnSync("git", ["init"], { cwd: root });
  spawnSync("git", ["config", "user.email", "demo@example.invalid"], { cwd: root });
  spawnSync("git", ["config", "user.name", "Demo"], { cwd: root });
  await write(root, "src/auth.ts", "export const ok = true;\n");
  await write(root, "src/helper.ts", "export const helper = 1;\n");
  await write(
    root,
    "package.json",
    JSON.stringify({ name: "demo", scripts: { test: "node -e \"process.exit(0)\"" } }, null, 2),
  );

  const engine = await TimeMachineEngine.open({
    workspaceRoot: root,
    dataDir: data,
    requireRestoreApproval: false,
    validation: { commands: ["node -e \"process.exit(0)\""] },
  });
  await engine.ensureBaseline();
  await engine.observeToolPre({ toolName: "edit_file", args: { path: "src/auth.ts" }, toolCallId: "1" });
  await write(root, "src/auth.ts", "export const ok = true; // still good\n");
  await engine.observeToolResult({ toolName: "edit_file", args: { path: "src/auth.ts" }, toolCallId: "1" });
  const good = await engine.checkpoint({ reason: "manual", label: "CP-GOOD tests passing" });
  await engine.validate(good.id);

  await engine.observeToolPre({ toolName: "edit_file", args: { path: "src/config.ts" }, toolCallId: "2" });
  await write(root, "src/config.ts", "export default { broken: true }\n");
  await engine.observeToolResult({ toolName: "edit_file", args: { path: "src/config.ts" }, toolCallId: "2" });
  await engine.observeToolPre({ toolName: "delete_file", args: { path: "src/helper.ts" }, toolCallId: "3" });
  await rm(join(root, "src/helper.ts"), { force: true });
  await engine.observeToolResult({ toolName: "delete_file", args: { path: "src/helper.ts" }, toolCallId: "3" });

  console.log("Last Known Good:\n");
  console.log(`  ${good.id}`);
  console.log("  tests passing");
  console.log("  2 mutations ago\n");
  const result = await engine.restoreLastKnownGood({ approved: true, mode: "restore-and-fork" });
  console.log("Restore last known good\n");
  console.log(`  Workspace restored ${result.status === "success" ? "✓" : result.status}`);
  console.log(`  Session forked     ${result.newSessionId ? "✓" : "recording adapter"}`);
  console.log(`  Tests              ${result.verificationPassed ? "PASS ✓" : "see validation"}`);
  console.log("\nThen continue: Try another approach.");
  engine.close();
  await rm(root, { recursive: true, force: true });
  await rm(data, { recursive: true, force: true });
}

await main();
