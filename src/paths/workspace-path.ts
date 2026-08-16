import { lstat, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { TimeMachineError } from "../domain/errors.ts";

const TRAVERSAL = /(^|[\\/])\.\.([\\/]|$)/;

export function assertRelativeSafe(relPath: string): string {
  const cleaned = relPath.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!cleaned || cleaned === ".") {
    throw new TimeMachineError("PATH_TRAVERSAL", "Empty snapshot path is not allowed.");
  }
  if (isAbsolute(relPath) || cleaned.startsWith("/") || /^[A-Za-z]:/.test(cleaned)) {
    throw new TimeMachineError(
      "PATH_TRAVERSAL",
      `Absolute paths are not allowed in snapshot metadata: ${relPath}`,
    );
  }
  if (TRAVERSAL.test(cleaned) || cleaned.split("/").includes("..")) {
    throw new TimeMachineError(
      "PATH_TRAVERSAL",
      `Path traversal is not allowed: ${relPath}`,
    );
  }
  return cleaned;
}

export function toPosixRel(relPath: string): string {
  return assertRelativeSafe(relPath).replaceAll("\\", "/");
}

export async function resolveWorkspaceRoot(root: string): Promise<string> {
  const resolved = resolve(root);
  const real = await realpath(resolved);
  return real;
}

export function isInsideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export async function resolveInsideWorkspace(
  workspaceRoot: string,
  relPath: string,
): Promise<{ abs: string; rel: string; real: string }> {
  const rel = toPosixRel(relPath);
  const abs = normalize(join(workspaceRoot, ...rel.split("/")));
  if (!isInsideRoot(workspaceRoot, abs)) {
    throw new TimeMachineError(
      "PATH_ESCAPE",
      `Path escapes workspace: ${relPath}`,
      { relPath, abs },
    );
  }

  let real = abs;
  try {
    real = await realpath(abs);
  } catch {
    const parent = await realpathExistingParent(workspaceRoot, abs);
    if (!isInsideRoot(workspaceRoot, parent)) {
      throw new TimeMachineError(
        "SYMLINK_ESCAPE",
        `Parent path escapes workspace: ${relPath}`,
        { relPath, parent },
      );
    }
    real = abs;
  }

  if (!isInsideRoot(workspaceRoot, real)) {
    throw new TimeMachineError(
      "SYMLINK_ESCAPE",
      `Resolved path escapes workspace: ${relPath}`,
      { relPath, real },
    );
  }
  return { abs, rel, real };
}

async function realpathExistingParent(workspaceRoot: string, abs: string): Promise<string> {
  let current = abs;
  while (current !== workspaceRoot && current !== "/" && current.length > 1) {
    const parent = resolve(current, "..");
    try {
      await stat(parent);
      return await realpath(parent);
    } catch {
      current = parent;
    }
  }
  return workspaceRoot;
}

export async function assertSymlinkSafe(
  workspaceRoot: string,
  linkAbs: string,
  target: string,
): Promise<string> {
  const resolvedTarget = isAbsolute(target)
    ? normalize(target)
    : normalize(join(linkAbs, "..", target));
  let realTarget = resolvedTarget;
  try {
    realTarget = await realpath(resolvedTarget);
  } catch {
    const parent = await realpathExistingParent(workspaceRoot, resolvedTarget);
    if (!isInsideRoot(workspaceRoot, parent)) {
      throw new TimeMachineError(
        "SYMLINK_ESCAPE",
        `Symlink target parent escapes workspace: ${target}`,
        { target, parent },
      );
    }
    if (!isInsideRoot(workspaceRoot, resolvedTarget)) {
      throw new TimeMachineError(
        "SYMLINK_ESCAPE",
        `Symlink target escapes workspace: ${target}`,
        { target, resolvedTarget },
      );
    }
    return resolvedTarget;
  }
  if (!isInsideRoot(workspaceRoot, realTarget)) {
    throw new TimeMachineError(
      "SYMLINK_ESCAPE",
      `Symlink target escapes workspace: ${target}`,
      { target, realTarget },
    );
  }
  return realTarget;
}

export async function lstatSafe(path: string) {
  return lstat(path);
}
