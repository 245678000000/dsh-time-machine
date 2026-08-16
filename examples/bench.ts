/**
 * Real micro-benchmarks on this machine. Not marketing numbers.
 *
 *   pnpm bench
 */
import { mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { TimeMachineEngine } from "../src/engine.ts";

async function populate(root: string, files: number, bytes: number) {
  await mkdir(join(root, "src"), { recursive: true });
  const payload = "x".repeat(bytes);
  for (let i = 0; i < files; i += 1) {
    await writeFile(join(root, "src", `f${i}.txt`), payload);
  }
}

async function timed(label: string, fn: () => Promise<void>) {
  const t0 = performance.now();
  await fn();
  const ms = performance.now() - t0;
  console.log(`${label.padEnd(42)} ${ms.toFixed(1)} ms`);
  return ms;
}

async function main() {
  const root = join(tmpdir(), `dsh-tm-bench-${Date.now()}`);
  const data = `${root}-data`;
  await mkdir(root, { recursive: true });
  const engine = await TimeMachineEngine.open({
    workspaceRoot: root,
    dataDir: data,
    requireRestoreApproval: false,
  });

  await populate(root, 50, 200);
  await timed("checkpoint small repo (50 files)", async () => {
    await engine.ensureBaseline();
  });

  await populate(root, 400, 200);
  await timed("checkpoint medium repo (~450 files)", async () => {
    await engine.checkpoint({ reason: "manual", label: "medium" });
  });

  await writeFile(join(root, "src/f0.txt"), "changed");
  await timed("incremental checkpoint 1 file change", async () => {
    await engine.checkpoint({ reason: "automatic", label: "delta" });
  });

  const last = engine.list().at(-1)!;
  await timed("restore preview", async () => {
    await engine.previewRestore(last.id);
  });

  engine.close();
  await rm(root, { recursive: true, force: true });
  await rm(data, { recursive: true, force: true });
}

await main();
