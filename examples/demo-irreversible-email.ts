/**
 * Killer demo 2 — Time Machine does not lie about email.
 *
 *   pnpm demo:email
 */
import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TimeMachineEngine, formatPreview } from "../src/engine.ts";

async function main() {
  const root = join(tmpdir(), `dsh-tm-demo-email-${Date.now()}`);
  const data = `${root}-data`;
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "draft.md"), "hello");
  const engine = await TimeMachineEngine.open({
    workspaceRoot: root,
    dataDir: data,
    requireRestoreApproval: false,
  });
  await engine.ensureBaseline();
  const start = engine.list().at(-1)!;
  await engine.observeToolPre({ toolName: "edit_file", args: { path: "draft.md" }, toolCallId: "e1" });
  await writeFile(join(root, "draft.md"), "edited locally");
  await engine.observeToolResult({ toolName: "edit_file", args: { path: "draft.md" }, toolCallId: "e1" });
  await engine.observeToolPre({
    toolName: "send_email",
    args: { to: "test@example.invalid", subject: "demo" },
    toolCallId: "e2",
  });
  await engine.observeToolResult({
    toolName: "send_email",
    args: { to: "test@example.invalid", subject: "demo" },
    toolCallId: "e2",
  });
  const preview = await engine.previewRestore(start.id);
  console.log(formatPreview(preview));
  const result = await engine.restore(start.id, { approved: true, mode: "restore-and-fork" });
  console.log("\nWORKSPACE RESTORED", result.status === "success" ? "✓" : result.status);
  console.log("SESSION FORKED    ", result.newSessionId ? "✓" : "(recording)");
  console.log("\nWARNING\nThe following action was not undone:");
  console.log("Email sent to test@example.invalid");
  engine.close();
  await rm(root, { recursive: true, force: true });
  await rm(data, { recursive: true, force: true });
}

await main();
