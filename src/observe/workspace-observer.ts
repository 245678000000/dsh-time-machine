import type { FileEntry } from "../domain/types.ts";
import { entryMap, fileSignature } from "../snapshot/scan.ts";

export function diffEntries(before: FileEntry[], after: FileEntry[]): {
  created: string[];
  deleted: string[];
  modified: string[];
} {
  const a = entryMap(before);
  const b = entryMap(after);
  const created: string[] = [];
  const deleted: string[] = [];
  const modified: string[] = [];
  for (const [path, entry] of a) {
    const other = b.get(path);
    if (!other) deleted.push(path);
    else if (fileSignature(entry) !== fileSignature(other)) modified.push(path);
  }
  for (const [path] of b) {
    if (!a.has(path)) created.push(path);
  }
  return { created, deleted, modified };
}
