import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { TimeMachineError } from "../domain/errors.ts";
import type { ContentRef } from "../domain/types.ts";

export class BlobStore {
  constructor(private readonly root: string) {}

  pathFor(hash: string): string {
    return join(this.root, hash.slice(0, 2), hash.slice(2, 4), hash);
  }

  hash(content: Buffer | Uint8Array | string): string {
    return createHash("sha256").update(content).digest("hex");
  }

  async put(content: Buffer | Uint8Array | string): Promise<ContentRef> {
    const buf = typeof content === "string" ? Buffer.from(content) : Buffer.from(content);
    const hash = this.hash(buf);
    const dest = this.pathFor(hash);
    try {
      await stat(dest);
      return { hash, bytes: buf.byteLength };
    } catch {
      await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
      const tmp = `${dest}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, buf, { mode: 0o600 });
      const written = await readFile(tmp);
      if (this.hash(written) !== hash) {
        await rm(tmp, { force: true });
        throw new TimeMachineError("CHECKPOINT_CORRUPTED", "Blob write failed integrity check.");
      }
      await rename(tmp, dest);
      return { hash, bytes: buf.byteLength };
    }
  }

  async get(hash: string): Promise<Buffer> {
    const dest = this.pathFor(hash);
    let buf: Buffer;
    try {
      buf = await readFile(dest);
    } catch {
      throw new TimeMachineError("CHECKPOINT_CORRUPTED", `Missing blob ${hash}`);
    }
    if (this.hash(buf) !== hash) {
      throw new TimeMachineError(
        "CHECKPOINT_CORRUPTED",
        `Blob hash mismatch for ${hash}`,
      );
    }
    return buf;
  }

  async has(hash: string): Promise<boolean> {
    try {
      await stat(this.pathFor(hash));
      return true;
    } catch {
      return false;
    }
  }

  async verify(hash: string): Promise<void> {
    await this.get(hash);
  }

  async dispose(hash: string): Promise<void> {
    await rm(this.pathFor(hash), { force: true });
  }

  async usageBytes(): Promise<number> {
    const { readdir } = await import("node:fs/promises");
    let total = 0;
    const walk = async (dir: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) {
          const s = await stat(full);
          total += s.size;
        }
      }
    };
    await walk(this.root);
    return total;
  }
}
