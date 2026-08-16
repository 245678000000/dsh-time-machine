# dsh-time-machine

撤销的是 Agent 搞坏的工程，不是聊天记录。

> When your agent breaks it, go back.

DeepSeek Harness 的工作区检查点、回滚、会话分叉与副作用账本。

**会话分叉 ≠ 工作区回滚。**

```text
GOOD
  ● CP-12
  │
  ├──── 方案 A
  │       ↓
  │      FAIL
  │
  └──── 方案 B
          ↓
         PASS
```

## 安装

需要 **Node.js ≥ 22.5**（用内置 `node:sqlite` 做崩溃安全的元数据）。

### 全局 CLI

```bash
npm i -g dsh-time-machine
# 或
pnpm add -g dsh-time-machine
```

装完直接用：

```bash
dsh-time-machine status
```

不想全局安装也可以：

```bash
npx dsh-time-machine status
```

### 作为项目依赖

```bash
pnpm add dsh-time-machine
# 或
npm i dsh-time-machine
```

### 从源码安装

```bash
git clone https://github.com/245678000000/dsh-time-machine.git
cd dsh-time-machine
pnpm install
pnpm build
node dist/cli.js status
```

DeepSeek Harness 相关包是**可选** peer dependency。没有 Harness 也能用 CLI 和核心引擎。

---

## 它解决什么

Agent 改了 18 个文件、删了资源、跑挂测试之后，你需要的不是「重新开一个对话」，而是：

1. 回到做错之前的**工作区**
2. 在对应边界上 **fork 一个看不到失败未来的新 session**
3. 被明确告知：哪些外部动作**已经无法自动撤销**

```text
Session Fork
≠
Workspace Rollback

dsh-time-machine = Session + 文件系统 + Git + 副作用账本
```

## 能恢复什么 / 不能恢复什么

| 对象 | v0.1 |
|---|---|
| Time Machine 观察到的工作区文件 | 能，从内容寻址 blob 恢复 |
| Agent 启动前用户已有的未提交改动 | **保留**。绝不 `git reset --hard` / `git clean -fd` |
| Git HEAD / 分支 / dirty 列表 | 只记录，不改写历史 |
| Harness session | 调用官方 `session.fork({ sessionId, atSeq })` |
| 副作用账本 | 只追加，不覆盖 |
| 已发出的邮件 | **不能撤回** |
| 任意远程 API / 数据库 / 进程 | **默认不能**，除非以后有明确 adapter |

**绝不宣称超过真实能力的可逆性。**

## 最快上手

在项目根目录：

```bash
dsh-time-machine init
dsh-time-machine checkpoint "开始干活之前"
# Agent 把项目搞坏之后
dsh-time-machine list
dsh-time-machine preview <checkpoint>
dsh-time-machine restore <checkpoint> --yes
```

默认 restore = **恢复工作区 + 在 checkpoint 边界 fork session**。

| 命令 | 工作区 | Session |
|---|---|---|
| `fork` / `--fork-only` | 不动 | 官方 fork |
| `--workspace-only` | 恢复 | 不声称 session 回退 |
| `restore`（默认） | 恢复 | 在边界 fork |

不带 `--yes` 时，restore **只预览不落盘**。

## CLI

```bash
dsh-time-machine status
dsh-time-machine checkpoint "before migration"
dsh-time-machine list
dsh-time-machine diff CP-07
dsh-time-machine preview CP-07
dsh-time-machine restore CP-07 --yes
dsh-time-machine effects
dsh-time-machine fork CP-07
dsh-time-machine restore CP-07 --workspace-only --yes
dsh-time-machine known-good --yes
```

数据默认在本机：

```text
~/.dsh-time-machine/<workspace-hash>/
  meta.sqlite
  blobs/ab/cd/<sha256>
  workspace.lock
```

如果你故意把数据目录放进仓库，它会**建议**把 `.dsh-time-machine` 写入 `.gitignore`，但不会擅自改你的 `.gitignore`。

## 接到 DeepSeek Harness

已对照官方 `deepseek-ai/deepseek-harness@47f9438`（`dsh@0.1.0-rc.5`）。接口说明见 [docs/harness-integration.md](docs/harness-integration.md)。

```ts
import * as timeMachine from "dsh-time-machine/plugin";
```

```yaml
- dsh-time-machine:
    checkpoints:
      onTaskStart: true
      beforeDestructiveTool: true
      beforeExternalAction: true
      afterMutations: 10
      maxCheckpoints: 50
      maxStorageMB: 2048
```

插件会：

1. 挂官方 `tools/pre-execute` / `tools/result`（不 deny，不改 AgentLoop）
2. 在 `agent/session-start` 建立工作区 baseline
3. 注册 9 个工具：`time_machine_status`、`time_machine_checkpoint`、`time_machine_list`、`time_machine_diff`、`time_machine_preview_restore`、`time_machine_restore`、`time_machine_fork`、`time_machine_branch`、`time_machine_side_effects`
4. restore+fork 或 fork-only 时调用官方 `session.fork`

## 脏工作区

任务开始时，已有文件标成 **用户既有改动**。

回滚只撤销 **Agent 造成的变更**。你未提交的 `thesis.md` 会留下。如果 Agent 也改过同一文件，回到的是 **Agent 动手前的用户版本**，不是 Git `HEAD`。

checkpoint 之后的并发修改会变成 `RESTORE_CONFLICT`，不会默默覆盖。

## 副作用账本

按工具名 **和** 参数分类，也可以注册 `TimeMachineSideEffectDescriptor`。

```text
edit_file            ✓ 可逆
git commit           ⚠ 有条件可逆
send_email           ✕ 不可逆
create_issue         ⚠ 需要 adapter / 人工
DROP DATABASE        ✕ / ?
production deploy    ?
```

Restore 预览一定会写出哪些动作撤不掉。v0.1 的 undo adapter 接口在，实现是故意什么都不装的 `NoopUndoAdapter`。

## 恢复流程

```text
预览 → 审批 → 加锁 → 校验 blob →
紧急 checkpoint → 暂存写入 → rename →
校验 hash → 官方 fork → 记账 → 解锁
```

恢复不完整时返回 `partial` 或 `failed`，**绝不返回 `success`**。

## 已知良好点

配置 `validation.commands`（例如 `npm test`）。通过后标记为 `★ KNOWN GOOD`。

```bash
dsh-time-machine known-good --yes
```

`find-bad` 可以在隔离临时目录里二分，**不会**在你的主工作区反复 destructive restore。

## 安全

- 路径必须落在工作区根内
- 拒绝 symlink 逃逸和 `../` 穿越
- restore 前校验每个 blob 的 sha256
- 工作区锁：抢不到就是 `RESTORE_BUSY`
- 数据目录权限 `0700` / `0600`
- 不会去扫 `$HOME`、`~/.ssh` 或任何未配置的根目录

## 三个演示

```bash
pnpm demo:known-good    # 回到最后一个已知良好点
pnpm demo:email         # 工作区恢复了，邮件仍显示未撤回
pnpm demo:user-work     # thesis.md 保留，Agent 改的 src/app.ts 撤销
```

## 测试与构建

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## 限制（必须诚实）

- 不能撤回已发出的邮件
- 不能普遍回滚远程 API
- 没有 adapter 就不能恢复任意数据库
- 不能恢复任意正在跑的进程
- 观察范围外的副作用不保证能撤
- 另一个进程同时改同一工作区时，归属只是尽力而为
- `npm install` 只恢复被捕获的文件，不管全局 cache / 安装脚本的网络效果
- v0.1 没有 Web UI timeline
- 没有 Harness 时，fork 只记账，不是活 session
- Node 22 的 `node:sqlite` 仍是 experimental

## 路线图

- **v0.1** 本地 checkpoint、Git 感知保护、官方 session fork、restore 预览、副作用账本、known-good、CLI
- **v0.2** Time Machine UI、bisect UX、更好的 Code Mode 归属、更快扫描
- **v0.3** 真正的外部 undo adapter（GitHub、部署、数据库快照），失败就说失败
- **v0.4** 团队共享 checkpoint

## License

MIT

---

<details>
<summary>English</summary>

Undo agent mistakes, not just conversations. Session fork is not workspace rollback.

See the Chinese sections above for install, CLI, and limitations. Integration notes: [docs/harness-integration.md](docs/harness-integration.md).

</details>
