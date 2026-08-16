# dsh-time-machine

Undo agent mistakes, not just conversations.

Checkpoint.
Break things.
Go back.
Try another branch.

```text
GOOD
  ● CP-12
  │
  ├──── Attempt A
  │       ↓
  │      FAIL
  │
  └──── Attempt B
          ↓
         PASS
```

```text
Session Fork
≠
Workspace Rollback

dsh-time-machine:

Session
   +
Filesystem
   +
Git
   +
Side-effect ledger
```

> When your agent breaks it, go back.

Checkpoint, rollback, fork and replay for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) agents.

## Why

An agent that rewrites 18 files and then fails tests does not need “a new chat”.

It needs **the workspace from before the bad step**, a **session that cannot see the failed future**, and an honest list of **things that already escaped into the world**.

## What it restores

| Surface | v0.1 |
|---|---|
| Workspace files Time Machine observed | Yes, from content-addressed blobs |
| Pre-existing dirty / untracked user work | Preserved. Never `git reset --hard`. Never `git clean -fd`. |
| Git metadata (HEAD, branch, dirty list) | Recorded. Not rewritten. |
| Harness session | Official `session.fork({ sessionId, atSeq })` at a completed `turn/end` |
| Side-effect ledger | Always kept, append-only |

## What it cannot restore

- Cannot unsend email.
- Cannot universally roll back remote APIs.
- Cannot restore arbitrary database state without an adapter.
- Cannot restore arbitrary running process state.
- Cannot guarantee rollback of side effects produced outside observed tools.
- Cannot guarantee perfect mutation attribution if another process edits the same workspace concurrently.

**Never claim more reversibility than actually exists.**

## Install

```bash
pnpm add dsh-time-machine
# or
npx dsh-time-machine status
```

Node.js **≥ 22.5** (uses `node:sqlite` for crash-safe metadata).

DeepSeek Harness packages are **optional peer dependencies**. The CLI and core engine run without them.

## CLI

```bash
dsh-time-machine status
dsh-time-machine checkpoint "before migration"
dsh-time-machine list
dsh-time-machine diff CP-07
dsh-time-machine preview CP-07
dsh-time-machine restore CP-07 --yes
dsh-time-machine effects
dsh-time-machine fork CP-07          # session only, no file writes
dsh-time-machine restore CP-07 --workspace-only --yes
dsh-time-machine known-good --yes
```

Restore always **previews first** unless you pass `--yes`.

## Harness integration

Verified against `deepseek-ai/deepseek-harness@47f943859bef60e4160492346772ded9b24f765a` (`dsh@0.1.0-rc.5`). Details: [docs/harness-integration.md](docs/harness-integration.md).

```ts
// cordis plugin
import * as timeMachine from 'dsh-time-machine/plugin'
```

```yaml
# example composition
- dsh-time-machine:
    checkpoints:
      onTaskStart: true
      beforeDestructiveTool: true
      beforeExternalAction: true
      afterMutations: 10
      maxCheckpoints: 50
      maxStorageMB: 2048
```

The plugin:

1. Hooks official `tools/pre-execute` and `tools/result` (does not deny, does not wrap the loop).
2. Establishes a **workspace baseline** on `agent/session-start`.
3. Registers nine tools: `time_machine_status`, `time_machine_checkpoint`, `time_machine_list`, `time_machine_diff`, `time_machine_preview_restore`, `time_machine_restore`, `time_machine_fork`, `time_machine_branch`, `time_machine_side_effects`.
4. Calls official `session.fork` when you restore+fork or fork-only.

## Architecture

```text
CLI / plugin tools
        │
TimeMachineEngine
        │
 ┌──────┴──────┬─────────────┬──────────────┐
 snapshot      restore        side-effect     session adapter
 git+file      planner        classifier      official fork
 blob store    executor       append-only     (not reimplemented)
 SQLite meta   verifier       undo adapters   recording fallback
```

Storage is **local first**:

```text
~/.dsh-time-machine/<workspace-hash>/
  meta.sqlite          # checkpoints, mutations, ledger, branches
  blobs/ab/cd/<sha256> # content-addressed file bytes
  workspace.lock
```

If you deliberately put the data directory inside a repo, Time Machine **suggests** adding `.dsh-time-machine` to `.gitignore`. It will **not** edit `.gitignore` for you.

## Checkpoint model

A checkpoint is a **coherent boundary**, not a log line. It is refused as a full restore point while a tool call is still open.

```ts
reason:
  | "automatic"
  | "manual"
  | "pre-risk-action"
  | "pre-batch-edit"
  | "pre-external-action"
  | "pre-restore"    // emergency undo-the-undo
  | "task-start"
```

Only `status === "ready"` can be restored. Integrity is `sha256` of every blob.

## Workspace snapshots

- **Git preferred** for inventory (`git status`, `git ls-files`).
- **File walk fallback** for non-git trees.
- Incremental: baseline + changed paths + content-addressed blobs. No full-repo copy.
- Restore writes staged temp files, then renames. Partial failure is reported as `partial`, never `success`.

## Dirty workspace handling

At task start Time Machine records every relevant file as **USER PRE-EXISTING**.

Rollback only reverts **agent-owned** mutations. Your uncommitted `thesis.md` stays. If the agent also edited that file, restore goes back to the **pre-agent user bytes**, not `HEAD`.

Concurrent edits after a checkpoint are `RESTORE_CONFLICT`. Nothing is silently overwritten.

## Session fork integration

```text
Turn 1
Turn 2
Turn 3
CP-A          ← last completed turn/end
Turn 4 bad
Turn 5 bad
        \
         New session from official session.fork({ atSeq })
```

Three distinct commands:

| Command | Workspace | Session |
|---|---|---|
| `fork` / `--fork-only` | untouched | official fork |
| `--workspace-only` | restored | not claimed |
| `restore` (default) | restored | fork at checkpoint boundary |

## Side-effect ledger

Classification uses tool name **and** arguments, plus optional `TimeMachineSideEffectDescriptor` registrations.

```text
edit_file            ✓ reversible
git commit           ⚠ conditionally reversible
send_email           ✕ irreversible
create_issue         ⚠ adapter / manual
DROP DATABASE        ✕ / ?
production deploy    ?
```

Restore preview always prints what cannot be undone.

v0.1 undo adapters exist as an interface. The shipped adapter is `NoopUndoAdapter`. That is intentional.

## Restore workflow

```text
preview → approval → lock → verify blobs →
emergency checkpoint → stage writes → rename →
verify hashes → official fork → ledger → unlock
```

## Known-good checkpoints

Configure `validation.commands` (for example `npm test`). A passing run is marked `★ KNOWN GOOD`. `dsh-time-machine known-good --yes` restores the latest one.

`find-bad` can binary-search **isolated temp trees**. It never repeatedly `restore`s your real workspace to bisect.

## Safety

- Canonical path checks, workspace-root enforcement
- Symlink escape rejected
- Snapshot path traversal rejected
- Blob hash verified before restore
- Restore lock (`RESTORE_BUSY` if contended)
- Restrictive `0700` / `0600` permissions on the data dir
- No snapshot of `$HOME`, `~/.ssh`, or anything outside the configured root

## Examples

```bash
pnpm demo:known-good    # restore last known good
pnpm demo:email         # workspace restored, email still sent
pnpm demo:user-work     # thesis.md preserved, agent file reverted
```

## Testing

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Performance

Checkpoints store **deltas + hashes**, not a 3 GB clone. Run `pnpm bench` on your machine and believe only that output.

## Limitations

See “What it cannot restore”. Also:

- Process / dev-server state is not snapshotted.
- `npm install` restores captured files, not global caches or install-script network effects.
- Attribution is best-effort when tools lie or unobserved processes write files.
- Isolated bisect materializes files in a temp dir; it is not a full OS sandbox.

## Roadmap

**v0.1** — local checkpoints, git-aware preservation, official session fork, restore preview, side-effect ledger, known-good, CLI.

**v0.2** — Time Machine UI, checkpoint bisect UX, better Code Mode attribution, faster scans.

**v0.3** — real external undo adapters (GitHub, deploys, DB snapshots) that still refuse to lie.

**v0.4** — shared / team checkpoint workflows.

## License

MIT
