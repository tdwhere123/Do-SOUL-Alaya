# Glossary

本页维护中文语义与英文 canonical identifier 的对应关系。外部展示名使用 **Do-SOUL Alaya**，命名空间目标为 `@do-soul/alaya`。

| 中文术语 | Canonical Identifier | 说明 |
|---|---|---|
| Do-SOUL Alaya | `do-soul-alaya` | 产品展示名（当前约定）。 |
| 命名空间目标 | `@do-soul/alaya` | 包与接口命名目标；未到发布阶段前保持目标态描述。 |
| 记忆对象 | `memory-object` | 本体真值对象。 |
| 投影 | `projection` | 面向展示或计算的派生视图，不是持久真值。 |
| 上下文包 | `context-pack` | 任务上下文封装，不直接等于 durable truth。 |
| 检视器状态 | `inspector-state` | UI/工具态，不构成持久事实。 |
| 基准视图 | `benchmark-view` | 评估视图，不构成持久事实。 |
| 持久记忆 | `durable-memory` | 带来源与证据、可审计的持久记录。 |
| 来源 | `source` | 记忆输入来源元数据。 |
| 证据 | `evidence` | 支撑 durable memory 的可追溯依据。 |
| 治理 | `governance` | 对策略、授权、导入导出、备份等变更的审计约束。 |
| 会话信任 | `session-trust` | 会话层信任姿态与变更记录。 |
| 适配器 | `adapter` | CLI/HTTP/MCP 等入口层实现。 |
| 运行时边界 | `runtime-boundary` | 适配器只能调用公共 runtime/API 边界，不可绕过它直接改存储。 |
| 文档重置态 | `docs-reset-state` | 当前仓库以文档为主，旧实现已删除。 |
| 未实现 | `not-implemented` | 功能尚无当前代码承载，不可宣称可运行。 |

## Usage

- 新增术语时，必须同时提供中文语义与英文 canonical identifier。
- 如术语影响状态判断（例如 `not-implemented` / `durable-memory`），同步检查 `runtime-status.md` 与 `code-map.md`。
