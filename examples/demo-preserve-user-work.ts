/**
 * Killer demo 3 — pre-existing user work is never deleted.
 *
 *   pnpm demo:user-work
 */
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { TimeMachineEngine } from "../src/engine.ts";

async function main() {
  const root = join(tmpdir(), `dsh-tm-demo-user-${Date.now()}`);
  const data = `${root}-data`;
  await mkdir(join(root, "src"), { recursive: true });
  spawnSync("git", ["init"], { cwd: root });
  spawnSync("git", ["config", "user.email", "demo@example.invalid"], { cwd: root });
  spawnSync("git", ["config", "user.name", "Demo"], { cwd: root });
  await writeFile(join(root, "src/app.ts"), "export const app = 1;\n");
  spawnSync("git", ["add", "."], { cwd: root });
  spawnSync("git", ["commit", "-m", "init"], { cwd: root });
  await writeFile(join(root, "thesis.md"), "uncommitted dissertation chapter\n");

  const engine = await TimeMachineEngine.open({
    workspaceRoot: root,
    dataDir: data,
    requireRestoreApproval: false,
  });
  await engine.ensureBaseline();
  const start = engine.list().at(-1)!;
  await engine.observeToolPre({ toolName: "edit_file", args: { path: "src/app.ts" }, toolCallId: "a1" });
  await writeFile(join(root, "src/app.ts"), "export const app = 'broken';\n");
  await engine.observeToolResult({ toolName: "edit_file", args: { path: "src/app.ts" }, toolCallId: "a1" });
  const result = await engine.restore(start.id, { approved: true, mode: "workspace-only" });
  const thesis = await readFile(join(root, "thesis.md"), "utf8");
  const app = await readFile(join(root, "src/app.ts"), "utf8");
  console.log("thesis.md");
  console.log(thesis.includes("uncommitted") ? "USER CHANGE PRESERVED ✓" : "FAILED");
  console.log("\nsrc/app.ts");
  console.log(app.includes("broken") ? "AGENT CHANGE STILL PRESENT" : "AGENT CHANGE REVERTED ✓");
  console.log("\nrestore status", result.status);
  engine.close();
  await rm(root, { recursive: true, force: true });
  await rm(data, { recursive: true, force: true });
}

await main();
