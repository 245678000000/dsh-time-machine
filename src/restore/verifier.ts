import type { FileEntry } from "../domain/types.ts";
import { entryMap, fileSignature, scanWorkspace } from "../snapshot/scan.ts";
import type { BlobStore } from "../storage/blob-store.ts";

export async function verifyRestoredState(input: {
  workspaceRoot: string;
  desired: FileEntry[];
  ignore: string[];
  maxFileBytes: number;
  blobs: BlobStore;
  preserve: Set<string>;
}): Promise<{ passed: boolean; mismatches: string[] }> {
  const scanned = await scanWorkspace({
    workspaceRoot: input.workspaceRoot,
    ignore: input.ignore,
    maxFileBytes: input.maxFileBytes,
    blobs: input.blobs,
    ownershipFor: () => "unknown",
  });
  const have = entryMap(scanned.entries);
  const want = entryMap(input.desired);
  const mismatches: string[] = [];
  for (const [path, entry] of want) {
    if (input.preserve.has(path)) continue;
    const current = have.get(path);
    if (!current || fileSignature(current) !== fileSignature(entry)) {
      mismatches.push(path);
    }
  }
  return { passed: mismatches.length === 0, mismatches };
}
