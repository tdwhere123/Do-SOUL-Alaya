<div align="right">

[English](README.md) | **简体中文**

</div>

# Do-SOUL Alaya

面向 CLI 编码 agent 的本地优先记忆平面（`@do-soul/alaya-*`）。
只有 MCP 和 CLI。没有对话 UI，没有遥测。

仓库内的当前事实以 handbook 为准。本 README 不声称 recall 已完整落地，
也不发布 KPI。

## Handbook

| 文件 | 职责 |
|---|---|
| [`docs/handbook/README.md`](docs/handbook/README.md) | Handbook 索引 |
| [`docs/handbook/invariants.md`](docs/handbook/invariants.md) | 始终优先的规则 |
| [`docs/handbook/architecture.md`](docs/handbook/architecture.md) | 包边界、对外面、写入模型、治理路径 |
| [`docs/handbook/recall.md`](docs/handbook/recall.md) | Recall 契约与 live / 历史路径 |
| [`docs/handbook/runtime-snapshot.md`](docs/handbook/runtime-snapshot.md) | 就绪用语与过时快照 |
| [`docs/handbook/backlog.md`](docs/handbook/backlog.md) | 非 recall 字段的未决问题 |
| [`docs/handbook/glossary.md`](docs/handbook/glossary.md) | 稳定词汇 |

Agent 工作副本：[`AGENTS.md`](AGENTS.md)。

## 快速开始

需要 Node 24+ 与 pnpm 9+。在源码目录：

```bash
pnpm install
pnpm build
pnpm exec alaya doctor
pnpm exec alaya install
pnpm exec alaya attach codex
pnpm exec alaya status
pnpm exec alaya tools list
pnpm exec alaya tools call --json
```

`alaya install` 可通过 `--non-interactive '<answers-json>'` 传入可选
JSON 答案（`db_path`、`embedding_enabled` 等）。裸跑 `alaya install`
会打印用法。

许可证：[AGPL-3.0](LICENSE)。
