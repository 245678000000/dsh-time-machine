import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chmodSync } from "node:fs";
import type {
  FileEntry,
  LedgerEvent,
  LedgerEventType,
  MutationRecord,
  SideEffectRecord,
  TimeMachineCheckpoint,
  TimelineBranch,
  ValidationRecord,
  WorkspaceBaseline,
} from "../domain/types.ts";
import { BlobStore } from "./blob-store.ts";
import { WorkspaceLock } from "./lock.ts";

export interface StoredSnapshot {
  id: string;
  createdAt: string;
  provider: "git+file" | "file" | "git";
  gitJson?: string;
  entries: FileEntry[];
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  known_good INTEGER NOT NULL DEFAULT 0,
  parent_id TEXT,
  branch_id TEXT NOT NULL,
  session_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  provider TEXT NOT NULL,
  git_json TEXT,
  entries_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mutations (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  timestamp TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS side_effects (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT UNIQUE NOT NULL,
  json TEXT NOT NULL,
  timestamp TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ledger (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS branches (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL
);
`;

export function defaultDataDir(workspaceRoot: string, override?: string): string {
  if (override) return override;
  const env = process.env.DSH_TM_HOME;
  if (env) return env;
  const id = createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 16);
  return join(homedir(), ".dsh-time-machine", id);
}

export class CheckpointStore {
  readonly blobs: BlobStore;
  readonly lock: WorkspaceLock;
  private db!: DatabaseSync;

  constructor(readonly dataDir: string) {
    this.blobs = new BlobStore(join(dataDir, "blobs"));
    this.lock = new WorkspaceLock(join(dataDir, "workspace.lock"));
  }

  async open(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    await mkdir(join(this.dataDir, "blobs"), { recursive: true, mode: 0o700 });
    const dbPath = join(this.dataDir, "meta.sqlite");
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    try {
      chmodSync(dbPath, 0o600);
    } catch {
      // best-effort local permission lock-down
    }
  }

  close(): void {
    this.db.close();
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  saveBaseline(baseline: WorkspaceBaseline): void {
    this.setMeta("baseline", JSON.stringify(baseline));
  }

  loadBaseline(): WorkspaceBaseline | undefined {
    const raw = this.getMeta("baseline");
    return raw ? (JSON.parse(raw) as WorkspaceBaseline) : undefined;
  }

  saveCheckpoint(cp: TimeMachineCheckpoint): void {
    this.db
      .prepare(
        `INSERT INTO checkpoints(id, json, created_at, status, pinned, known_good, parent_id, branch_id, session_id)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           json = excluded.json,
           status = excluded.status,
           pinned = excluded.pinned,
           known_good = excluded.known_good,
           parent_id = excluded.parent_id`,
      )
      .run(
        cp.id,
        JSON.stringify(cp),
        cp.createdAt,
        cp.status,
        cp.pinned ? 1 : 0,
        cp.knownGood ? 1 : 0,
        cp.parentCheckpointId ?? null,
        cp.branchId,
        cp.sessionId,
      );
  }

  getCheckpoint(id: string): TimeMachineCheckpoint | undefined {
    const row = this.db.prepare("SELECT json FROM checkpoints WHERE id = ?").get(id) as
      | { json: string }
      | undefined;
    return row ? (JSON.parse(row.json) as TimeMachineCheckpoint) : undefined;
  }

  listCheckpoints(): TimeMachineCheckpoint[] {
    const rows = this.db.prepare("SELECT json FROM checkpoints ORDER BY created_at ASC").all() as Array<{
      json: string;
    }>;
    return rows.map((r) => JSON.parse(r.json) as TimeMachineCheckpoint);
  }

  deleteCheckpoint(id: string): void {
    this.db.prepare("DELETE FROM checkpoints WHERE id = ?").run(id);
    this.db.prepare("DELETE FROM snapshots WHERE id = ?").run(id);
  }

  saveSnapshot(snapshot: StoredSnapshot): void {
    this.db
      .prepare(
        `INSERT INTO snapshots(id, created_at, provider, git_json, entries_json)
         VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET entries_json = excluded.entries_json`,
      )
      .run(
        snapshot.id,
        snapshot.createdAt,
        snapshot.provider,
        snapshot.gitJson ?? null,
        JSON.stringify(snapshot.entries),
      );
  }

  loadSnapshot(id: string): StoredSnapshot | undefined {
    const row = this.db
      .prepare("SELECT id, created_at, provider, git_json, entries_json FROM snapshots WHERE id = ?")
      .get(id) as
      | {
          id: string;
          created_at: string;
          provider: StoredSnapshot["provider"];
          git_json: string | null;
          entries_json: string;
        }
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      createdAt: row.created_at,
      provider: row.provider,
      gitJson: row.git_json ?? undefined,
      entries: JSON.parse(row.entries_json) as FileEntry[],
    };
  }

  addMutation(record: MutationRecord): void {
    this.db
      .prepare("INSERT INTO mutations(id, json, timestamp) VALUES(?, ?, ?)")
      .run(record.id, JSON.stringify(record), record.timestamp);
  }

  listMutations(): MutationRecord[] {
    const rows = this.db.prepare("SELECT json FROM mutations ORDER BY timestamp ASC").all() as Array<{
      json: string;
    }>;
    return rows.map((r) => JSON.parse(r.json) as MutationRecord);
  }

  addSideEffect(record: SideEffectRecord): number {
    const result = this.db
      .prepare("INSERT INTO side_effects(id, json, timestamp) VALUES(?, ?, ?)")
      .run(record.id, JSON.stringify(record), record.timestamp);
    return Number(result.lastInsertRowid);
  }

  listSideEffects(): SideEffectRecord[] {
    const rows = this.db.prepare("SELECT json FROM side_effects ORDER BY seq ASC").all() as Array<{
      json: string;
    }>;
    return rows.map((r) => JSON.parse(r.json) as SideEffectRecord);
  }

  sideEffectCursor(): number {
    const row = this.db.prepare("SELECT MAX(seq) AS seq FROM side_effects").get() as
      | { seq: number | null }
      | undefined;
    return row?.seq ?? 0;
  }

  appendLedger(type: LedgerEventType, payload: Record<string, unknown>): LedgerEvent {
    const timestamp = new Date().toISOString();
    const result = this.db
      .prepare("INSERT INTO ledger(type, timestamp, payload) VALUES(?, ?, ?)")
      .run(type, timestamp, JSON.stringify(payload));
    return {
      seq: Number(result.lastInsertRowid),
      type,
      timestamp,
      payload,
    };
  }

  listLedger(): LedgerEvent[] {
    const rows = this.db
      .prepare("SELECT seq, type, timestamp, payload FROM ledger ORDER BY seq ASC")
      .all() as Array<{ seq: number; type: LedgerEventType; timestamp: string; payload: string }>;
    return rows.map((r) => ({
      seq: r.seq,
      type: r.type,
      timestamp: r.timestamp,
      payload: JSON.parse(r.payload) as Record<string, unknown>,
    }));
  }

  saveBranch(branch: TimelineBranch): void {
    this.db
      .prepare("INSERT INTO branches(id, json) VALUES(?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json")
      .run(branch.id, JSON.stringify(branch));
  }

  listBranches(): TimelineBranch[] {
    const rows = this.db.prepare("SELECT json FROM branches").all() as Array<{ json: string }>;
    return rows.map((r) => JSON.parse(r.json) as TimelineBranch);
  }

  referencedBlobHashes(): Set<string> {
    const hashes = new Set<string>();
    const baseline = this.loadBaseline();
    if (baseline) {
      for (const e of baseline.entries) if (e.hash) hashes.add(e.hash);
    }
    for (const cp of this.listCheckpoints()) {
      const snap = this.loadSnapshot(cp.workspaceSnapshot.id);
      if (!snap) continue;
      for (const e of snap.entries) if (e.hash) hashes.add(e.hash);
    }
    for (const m of this.listMutations()) {
      if (m.before?.hash) hashes.add(m.before.hash);
      if (m.after?.hash) hashes.add(m.after.hash);
    }
    return hashes;
  }

  updateValidation(id: string, validation: ValidationRecord, knownGood: boolean): void {
    const cp = this.getCheckpoint(id);
    if (!cp) return;
    cp.validation = validation;
    cp.knownGood = knownGood;
    this.saveCheckpoint(cp);
  }
}
