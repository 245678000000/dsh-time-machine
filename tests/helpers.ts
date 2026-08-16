import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { TimeMachineEngine } from "../src/engine.ts";

export async function tempWorkspace(prefix = "dsh-tm-"): Promise<{
  root: string;
  data: string;
}> {
  const root = join(tmpdir(), `${prefix}${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const data = `${root}-data`;
  await mkdir(root, { recursive: true });
  await mkdir(data, { recursive: true });
  return { root, data };
}

export async function gitInit(root: string): Promise<void> {
  const run = (args: string[]) => {
    const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr || r.stdout || `git ${args.join(" ")} failed`);
  };
  run(["init"]);
  run(["config", "user.email", "tm@example.invalid"]);
  run(["config", "user.name", "Time Machine"]);
}

export async function write(root: string, rel: string, content: string): Promise<void> {
  const full = join(root, rel);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, content, "utf8");
}

export async function read(root: string, rel: string): Promise<string> {
  return readFile(join(root, rel), "utf8");
}

export async function exists(root: string, rel: string): Promise<boolean> {
  try {
    await readFile(join(root, rel));
    return true;
  } catch {
    return false;
  }
}

export async function openEngine(
  root: string,
  data: string,
  extras?: Partial<Parameters<typeof TimeMachineEngine.open>[0]>,
) {
  return TimeMachineEngine.open({
    workspaceRoot: root,
    dataDir: data,
    requireRestoreApproval: false,
    checkpoints: {
      onTaskStart: true,
      beforeDestructiveTool: true,
      beforeExternalAction: true,
      afterMutations: 10,
      maxCheckpoints: 50,
      maxStorageMB: 256,
    },
    ...extras,
  });
}

export async function agentEdit(
  engine: TimeMachineEngine,
  root: string,
  rel: string,
  content: string,
  tool = "edit_file",
): Promise<void> {
  const id = `call_${rel}_${Date.now()}`;
  await engine.observeToolPre({ toolName: tool, args: { path: rel }, toolCallId: id });
  await write(root, rel, content);
  await engine.observeToolResult({ toolName: tool, args: { path: rel }, toolCallId: id });
}

export async function agentDelete(
  engine: TimeMachineEngine,
  root: string,
  rel: string,
): Promise<void> {
  const id = `del_${rel}_${Date.now()}`;
  await engine.observeToolPre({ toolName: "delete_file", args: { path: rel }, toolCallId: id });
  await rm(join(root, rel), { force: true });
  await engine.observeToolResult({ toolName: "delete_file", args: { path: rel }, toolCallId: id });
}

export async function cleanup(paths: string[]): Promise<void> {
  for (const p of paths) await rm(p, { recursive: true, force: true });
}
