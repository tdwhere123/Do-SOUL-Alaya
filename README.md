# Do-SOUL Alaya

Do-SOUL Alaya 是面向 CLI agent 的本地优先长期记忆核心。

它不只是保存记忆，而是管理记忆如何形成、连接、召回、显影、治理，
并证明 agent 是否真的使用了它。

## 当前状态

本仓库处于 reset/extraction 阶段。

- 旧本地原型实现已按计划删除。
- 当前工作是文档与架构重置。
- 目标 package namespace 是 `@do-soul/alaya`。
- archive 文档只作为历史参考，不是当前真相。
- 除非后续迁移计划明确负责，不要恢复已删除的 `src/` 实现。

## 产品方向

Do-SOUL Alaya 是本地优先的 CLI agent memory core。它应当能通过同一组
公共接口接入 Codex、Claude Code，以及其它 agent CLI。

产品形态：

- 本地 daemon core：负责存储、runtime、召回、治理、审计与配置；
- MCP-first integration：作为 agent 访问的首要入口；
- CLI protocol 与 SDK/adapters：围绕同一 public API 提供备用接入；
- Attach/Profile installer：为 Codex、Claude Code 与项目级 agent rules
  生成接入配置，并让用户确认写入；
- 可选 Gateway mode：用于强制经过 Alaya 的测试、评测与 benchmark；
- Graph inspector：核心迁移完成后的 Phase 2 展示面板。

## 架构基线

Do-SOUL Alaya 将 SOUL 模型作为硬架构：

- `Memory Ontology`: durable memory truth.
- `Structure Registry`: routing, scope, surface, mapping, path, and governance
  registration.
- `Runtime Control Plane`: current-turn recall, activation, manifestation,
  context projection, and usage audit.

四轴保持正交：

- `Object`: 记住什么。
- `Path`: 对象与 facet 为什么在特定条件下连接。
- `Evidence`: 记忆为什么成立，以及支持度如何变化。
- `Governance`: 什么可以影响未来 agent 行为。

核心规则：

```text
Embedding affects what can be found.
LLM or connected agents propose what may become memory.
Alaya decides what is durable truth.
```

## 文档入口

从这里开始：

- [docs/README.md](docs/README.md) - 文档地图。
- [docs/handbook/README.md](docs/handbook/README.md) - 当前真相层级。
- [docs/handbook/architecture.md](docs/handbook/architecture.md) - 架构基线。
- [docs/handbook/invariants.md](docs/handbook/invariants.md) - 最高优先级规则。
- [docs/v0.1/README.md](docs/v0.1/README.md) - 第一轮完整产品闭环计划。

历史原型材料已归档到
[docs/archive/2026-04-27-old-prototype/](docs/archive/2026-04-27-old-prototype/).

## 操作文件

- [AGENTS.md](AGENTS.md) - Codex/operator 规则。
- [CLAUDE.md](CLAUDE.md) - Claude-oriented operator 规则。
- [RTK.md](RTK.md) - 本地 shell 命令前缀规则。
