# Harness integration notes

Inspected: **2026-08-16**

Upstream: [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)

Pinned commit used for API verification:

```text
47f943859bef60e4160492346772ded9b24f765a
Merge pull request #2519 — release: dsh@0.1.0-rc.5
```

Public npm family at inspection time: `@deepseek-ai/dsh@0.1.0-rc.5` / `0.1.0-rc.6` developer preview.

This file is the source of truth for what `dsh-time-machine` actually calls. If a name in the original product brief disagrees with this commit, **this commit wins**.

## Session APIs available

From `packages/core/session/src/types.ts` and `packages/core/session/src/index.ts`:

| Surface | Shape |
|---|---|
| `SessionStore.create` / `sessions.create(id, { seed })` | Replay / resume by seeding the event log |
| `SessionStore.fork(source, boundary?, childSessionId?)` | In-process fork |
| `CreateSessionOptions.seed` | Contiguous lossless-JSON prefix from seq 0 |
| `SessionHeader.parentSession` | Parent id |
| `SessionHeader.seedLength` | Inherited event count |
| `session/end-seed` | Durable marker after constructor seed |
| `session/created` | Persistence hook |

A fork seed must be a **balanced completed-turn prefix**: no open `turn` / `step`, no dangling tool call.

## Fork APIs available

Host RPC (`packages/host/apiproxy`):

```ts
// session.fork request
{ sessionId: SessionId; atSeq?: number }

// session.fork response
{ sessionId: SessionId } // child
```

Official cut rule (`api-proxy.ts`):

1. `atSeq` anchors the **first `turn/end` at or after `atSeq`**.
2. A message fork button therefore includes that whole turn.
3. Omitted or past-end `atSeq` uses the **last completed `turn/end`**.
4. If that turn is not finished → `fork-unavailable`.
5. The seed then extends through trailing out-of-band events until the next `turn/start`.
6. Child is created with `seed: events.slice(0, cut)`, `meta.parentSession`, `meta.seedLength = cut`.
7. Child attaches to the same `Workspace` via `workspace.attachSession(childId)`.

**Session fork does not restore files.** The official workspace attach only joins the child session to the same workspace record.

`dsh-time-machine` calls this via `HarnessSessionAdapter.fork({ sessionId, atSeq })` and **does not reimplement seed clipping**.

## Replay semantics

Official replay is **observational**:

- Persistence writes the event log (JSONL).
- Resume / replay = `sessions.create(id, { seed })`.
- UI presenters (`presentCall` / `presentResult`) must be pure functions of args + logged result. No I/O.
- Replay of a `diff` card uses persisted `tool/result.meta`, not a second write.

Time Machine replay is the same idea: walk the **side-effect + mutation ledger**. It does **not** re-run destructive tools. A user who wants a new execution creates a **new branch** (fork + new work).

## Tool execution hooks

Verified pipeline (`docs/tool-execution-pipeline.md`, `packages/core/tools`):

```text
tool/call
  → tools/pre-execute   (allow / deny / ask waterfall)
  → monotonic guards
  → ctx.approval        (only if ask)
  → tools/execute       (around-dispatch; may replace signal only)
  → tool body
      ↳ fs/write-intent | fs/edit-intent  (tool-fs mutations)
      ↳ fs/observed
  → tools/post-execute
  → finalizeContent
  → tools/result        (immutable authoritative outcome)
  → tool/result session event
```

Time Machine uses:

| Hook | Use |
|---|---|
| `tools/pre-execute` | Classify risk, maybe checkpoint, snapshot hashes **before** the body. Always `return next()`. Never deny. |
| `tools/result` | Observe actual workspace delta vs expected paths. Record mutations + side effects. |
| `fs/observed` | Additional filesystem evidence. |
| `session/event` | Track `turn/end` for fork-safe boundaries. |
| `agent/session-start` | Establish workspace baseline. |

It does **not** wrap `tools/execute`, fork `AgentLoop`, or monkey-patch tool bodies.

Code Mode: official `run_code` sub-calls re-enter the same pipeline with a parent token and log `tool/code-dispatch`. Time Machine therefore sees child mutations as ordinary `tools/pre-execute` / `tools/result` pairs when those events fire.

## Filesystem events

From `packages/fs/fs` and `dsh-tool-fs`:

- `fs/write-intent(target, actor, next)`
- `fs/edit-intent(target, actor, next)`
- `fs/observed(target, …)`

These are **not** a complete world-state journal. Shell/`bash` can still mutate the tree without `tool-fs`. That is why Time Machine **re-scans the workspace** after `tools/result` instead of trusting the tool return value.

## Workspace APIs

- `WorkspaceId` branded string
- `session.create` accepts `workspaceId` **or** `cwd`, not both
- `workspace.attachSession(sessionId)`
- Sessions store `header.cwd`

Time Machine treats the **configured workspace root** (cwd / `workspaceRoot`) as the only snapshot root. It never walks `$HOME`, `~/.ssh`, or sibling directories.

## Approval APIs

`ctx.approval` from `@deepseek-ai/dsh-user-approval`:

- `tools/pre-execute` may return `{ kind: 'ask' }`
- Absent / unanswerable approval **denies** the tool
- Restore is a high-impact action: Time Machine prefers `ctx.approval.request(...)` when present, otherwise requires an explicit `approved: true` / CLI `--yes`

## UI APIs

Stable enough for a **minimal** integration, not a first-class visual product in v0.1:

- Generic UI: `ctx.on('session/event', …)`
- Web client: `ConversationNodeDefinition` + keyed chat renderer (`docs/cookbook/extension-cookbook.md`)
- Official UI already has “Branch into a new conversation” → `session.fork`

v0.1 ships CLI + agent tools. A Time Machine timeline UI is deferred to v0.2 so restore reliability is not blocked on client slot APIs.

## Cordis plugin lifecycle

```ts
export const name = 'dsh-time-machine'
export const inject = []          // optional tools/sessions/approval via ctx.get
export function apply(ctx, config)
```

Registrations are effect-based. Disposing the fiber unregisters tools. No HMR-specific code.

## Subagents

`parentSession` / `origin: 'subagent'` / `delegationDepth` exist on `SessionHeader`.
`dsh-subagent-fork-in-process` seeds a child with the parent log cut at the last `turn/end`.

Time Machine records `sessionId` / `agentId` / `toolCallId` on mutations when the execution object carries them. It does **not** reimplement the subagent runtime.

## Actual adapter design used

```text
TimeMachineEngine          (pure domain: checkpoint / snapshot / restore / ledger)
        │
        ├── HarnessSessionAdapter     → official session.fork / SessionStore.fork
        ├── HarnessToolAdapter        → ctx.tools.register(defineTool-compatible defs)
        ├── HarnessApprovalAdapter    → ctx.approval.request
        ├── HarnessWorkspaceAdapter   → configured cwd / workspace root
        └── HarnessUiAdapter          → none in v0.1 (CLI + tools only)
```

Core restore, blob store, and classification have **zero** imports from `@deepseek-ai/*`. The plugin is an optional peer. The CLI works without Harness installed.

When official `session.fork` is missing (unit tests, standalone CLI), a `RecordingSessionAdapter` records the intended `{ sessionId, atSeq }` and returns a synthetic child id. That is labeled as a recording adapter in the ledger — it is **not** claimed to be a live Harness session.
