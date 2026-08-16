# Architecture (as implemented)

See the README for the product picture. This file is the map of the tree.

```text
src/
  engine.ts                 TimeMachineEngine
  plugin.ts                 Cordis apply()
  cli.ts                    dsh-time-machine
  domain/                   checkpoint / mutation / side-effect types
  paths/workspace-path.ts   traversal + symlink escape
  storage/                  SQLite metadata + blob store + lock
  snapshot/                 git-aware + file fallback, incremental
  restore/                  preview, plan, stage/commit, verify
  effects/                  classification, ledger, noop undo adapters
  checkpoint/               policy + lineage
  session/boundary.ts       official turn/end cut
  adapters/harness/         session / approval / workspace / ui
  tools/                    nine model-facing tools
  validation/               known-good commands
```

Core rule: **session fork is not workspace rollback.**
