import { mkdir, open, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { TimeMachineError } from "../domain/errors.ts";

export class WorkspaceLock {
  private handle: Awaited<ReturnType<typeof open>> | undefined;
  private held = false;

  constructor(private readonly lockPath: string) {}

  get isHeld(): boolean {
    return this.held;
  }

  async acquire(timeoutMs = 5_000): Promise<void> {
    await mkdir(dirname(this.lockPath), { recursive: true, mode: 0o700 });
    const started = Date.now();
    while (Date.now() - started <= timeoutMs) {
      try {
        this.handle = await open(this.lockPath, "wx", 0o600);
        await this.handle.writeFile(
          JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
        );
        this.held = true;
        return;
      } catch {
        try {
          const s = await stat(this.lockPath);
          const age = Date.now() - s.mtimeMs;
          if (age > 30 * 60_000) {
            await rm(this.lockPath, { force: true });
            continue;
          }
        } catch {
          // lock disappeared
        }
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    throw new TimeMachineError(
      "RESTORE_BUSY",
      "Could not acquire workspace restore lock.",
      { lockPath: this.lockPath },
    );
  }

  async release(): Promise<void> {
    if (this.handle) {
      await this.handle.close();
      this.handle = undefined;
    }
    if (this.held) {
      await rm(this.lockPath, { force: true });
      this.held = false;
    }
  }
}
