import { spawn } from "node:child_process";
import { resolve } from "node:path";

export interface GitStatusEntry {
  path: string;
  origPath?: string;
  xy: string;
  untracked: boolean;
}

export interface GitInfo {
  root: string;
  head?: string;
  branch?: string;
  dirty: boolean;
  entries: GitStatusEntry[];
}

function runGit(cwd: string, args: string[], timeoutMs = 15_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`git ${args.join(" ")} timed out`));
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? 1, stdout, stderr });
    });
  });
}

export async function detectGit(workspaceRoot: string): Promise<GitInfo | undefined> {
  try {
    const rootRes = await runGit(workspaceRoot, ["rev-parse", "--show-toplevel"]);
    if (rootRes.code !== 0) return undefined;
    const root = resolve(rootRes.stdout.trim());
    const headRes = await runGit(root, ["rev-parse", "HEAD"]);
    const branchRes = await runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const statusRes = await runGit(root, ["status", "--porcelain=v1", "-uall", "--ignore-submodules=all"]);
    const entries: GitStatusEntry[] = [];
    for (const line of statusRes.stdout.split("\n")) {
      if (!line) continue;
      const xy = line.slice(0, 2);
      const rest = line.slice(3);
      if (rest.includes(" -> ")) {
        const [from, to] = rest.split(" -> ");
        if (from && to) entries.push({ path: to, origPath: from, xy, untracked: xy === "??" });
      } else {
        entries.push({ path: rest, xy, untracked: xy === "??" });
      }
    }
    return {
      root,
      head: headRes.code === 0 ? headRes.stdout.trim() : undefined,
      branch: branchRes.code === 0 ? branchRes.stdout.trim() : undefined,
      dirty: entries.length > 0,
      entries,
    };
  } catch {
    return undefined;
  }
}

export async function gitTrackedFiles(root: string): Promise<string[]> {
  const res = await runGit(root, ["ls-files", "-z"]);
  if (res.code !== 0) return [];
  return res.stdout.split("\0").filter(Boolean);
}

export async function gitShow(root: string, spec: string): Promise<Buffer | undefined> {
  return new Promise((resolvePromise) => {
    const child = spawn("git", ["show", spec], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.on("close", (code) => {
      if (code !== 0) resolvePromise(undefined);
      else resolvePromise(Buffer.concat(chunks));
    });
    child.on("error", () => resolvePromise(undefined));
  });
}

export async function gitCheckIgnore(root: string, relPath: string): Promise<boolean> {
  const res = await runGit(root, ["check-ignore", "-q", "--", relPath]);
  return res.code === 0;
}
