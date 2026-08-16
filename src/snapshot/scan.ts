import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { join, relative } from "node:path";
import type { FileEntry, Ownership } from "../domain/types.ts";
import { assertSymlinkSafe, toPosixRel } from "../paths/workspace-path.ts";
import type { BlobStore } from "../storage/blob-store.ts";
import { detectGit, gitTrackedFiles } from "./git.ts";

export const DEFAULT_IGNORE = [
  ".git",
  "node_modules",
  ".dsh-time-machine",
  "dist",
  "build",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  ".DS_Store",
];

export interface ScanOptions {
  workspaceRoot: string;
  ignore: string[];
  maxFileBytes: number;
  blobs: BlobStore;
  extraPaths?: string[];
  ownershipFor: (rel: string) => Ownership;
}

export interface ScannedWorkspace {
  entries: FileEntry[];
  skipped: Array<{ path: string; reason: string }>;
  git?: Awaited<ReturnType<typeof detectGit>>;
}

function ignored(rel: string, ignore: string[]): boolean {
  const parts = rel.split("/");
  return ignore.some((pat) => parts.includes(pat) || rel === pat || rel.endsWith(`/${pat}`));
}

export async function scanWorkspace(opts: ScanOptions): Promise<ScannedWorkspace> {
  const skipped: Array<{ path: string; reason: string }> = [];
  const entries: FileEntry[] = [];
  const seen = new Set<string>();
  const git = await detectGit(opts.workspaceRoot);

  const consider = async (rel: string): Promise<void> => {
    const posix = toPosixRel(rel);
    if (seen.has(posix) || ignored(posix, opts.ignore)) return;
    seen.add(posix);
    const abs = join(opts.workspaceRoot, ...posix.split("/"));
    let st;
    try {
      st = await lstat(abs);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      entries.push({
        path: posix,
        type: "directory",
        mode: st.mode,
        ownership: opts.ownershipFor(posix),
      });
      return;
    }
    if (st.isSymbolicLink()) {
      const target = await readlink(abs);
      try {
        await assertSymlinkSafe(opts.workspaceRoot, abs, target);
      } catch (err) {
        skipped.push({ path: posix, reason: err instanceof Error ? err.message : String(err) });
        return;
      }
      entries.push({
        path: posix,
        type: "symlink",
        mode: st.mode,
        symlinkTarget: target,
        ownership: opts.ownershipFor(posix),
      });
      return;
    }
    if (!st.isFile()) {
      skipped.push({ path: posix, reason: "unsupported file type" });
      return;
    }
    if (st.size > opts.maxFileBytes) {
      skipped.push({ path: posix, reason: `file exceeds maxFileBytes (${st.size})` });
      return;
    }
    const content = await readFile(abs);
    const ref = await opts.blobs.put(content);
    entries.push({
      path: posix,
      type: "file",
      mode: st.mode,
      hash: ref.hash,
      size: ref.bytes,
      ownership: opts.ownershipFor(posix),
    });
  };

  if (git) {
    const tracked = await gitTrackedFiles(git.root);
    const gitRelPrefix = relative(git.root, opts.workspaceRoot);
    for (const file of tracked) {
      const absFromGit = join(git.root, file);
      const relFromWs = relative(opts.workspaceRoot, absFromGit).replaceAll("\\", "/");
      if (relFromWs.startsWith("..")) continue;
      if (gitRelPrefix && file.startsWith("..")) continue;
      await consider(relFromWs);
    }
    for (const entry of git.entries) {
      if (!entry.untracked && entry.xy.trim() === "") continue;
      const relFromWs = relative(opts.workspaceRoot, join(git.root, entry.path)).replaceAll("\\", "/");
      if (relFromWs.startsWith("..")) continue;
      await consider(relFromWs);
    }
  }

  const walk = async (dirAbs: string): Promise<void> => {
    let children;
    try {
      children = await readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) {
      const abs = join(dirAbs, child.name);
      const rel = relative(opts.workspaceRoot, abs).replaceAll("\\", "/");
      if (ignored(rel, opts.ignore)) continue;
      if (child.isDirectory() && !child.isSymbolicLink()) {
        await consider(rel);
        await walk(abs);
      } else {
        await consider(rel);
      }
    }
  };

  if (!git) {
    await walk(opts.workspaceRoot);
  } else {
    // Always pick up untracked / non-git paths that exist under the workspace
    // and were not already listed, except ignored trees.
    await walk(opts.workspaceRoot);
  }

  for (const extra of opts.extraPaths ?? []) {
    await consider(extra);
  }

  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { entries, skipped, git };
}

export function entryMap(entries: FileEntry[]): Map<string, FileEntry> {
  return new Map(entries.filter((e) => e.type !== "directory").map((e) => [e.path, e]));
}

export function fileSignature(entry: FileEntry): string {
  if (entry.type === "symlink") return `symlink:${entry.symlinkTarget ?? ""}:${entry.mode}`;
  if (entry.type === "directory") return `dir:${entry.mode}`;
  return `file:${entry.hash ?? ""}:${entry.mode}`;
}
