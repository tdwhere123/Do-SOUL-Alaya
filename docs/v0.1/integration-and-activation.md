# 集成与激活（v0.1 计划）

## 集成目标

支持任意 CLI agent 以稳定、本地优先的方式接入 Do-SOUL Alaya：

- MCP-first 作为通用能力面；
- CLI protocol fallback；
- Attach/Profile installer 作为行为面；
- Gateway mode 作为可选强制与 benchmark envelope；
- Session audit 作为证明面。

## Access Stack

1. Runtime API：语义根。
2. MCP adapter：第一接入协议。
3. CLI protocol adapter：fallback 与 operator 操作。
4. Attach/Profile installer：写入或生成 Codex/Claude 等 agent 规则。
5. Gateway runner：强制闭环与 benchmark。
6. Inspector / benchmark consumers。

## Installer 与 Profile Scope

Installer/profile 管理需要支持：

- User scope：
  - 跨项目默认配置；
  - 默认 data/profile path；
  - 默认 provider；
  - 默认 activation preference。
- Project scope：
  - workspace/repo 覆盖规则；
  - project recall constraints；
  - local sensitivity policy；
  - provider 禁用或替换。

计划 merge rule：project scope 覆盖 user scope 的冲突字段。

## Attach/Profile 行为

默认行为：生成配置草案并请求用户确认写入。

首批目标：

- Codex；
- Claude Code。

Attach/Profile 内容必须说明：

- 什么时候先 recall；
- 什么时候 post-run ingest；
- 什么时候引用 memory id / evidence；
- 什么时候记录 skipped / unverifiable；
- 高风险候选如何触发确认。

Attach 是 best-effort，不得宣称保证使用。

## Activation Modes

Connect：

- MCP tools/resources/prompts 可用。
- 低摩擦接入。
- 不保证 pre/post memory 行为。

Attach：

- 添加 profile/instruction assets。
- 提高主动调用概率。
- 仍是 best-effort，不是 enforcement。

Gateway：

- 包裹 agent launch；
- 尝试强制 pre-recall、context attachment、post-run ingest；
- 适合 benchmark 和需要强证明的任务。

## Fallback Behavior

MCP 不可用时：

- CLI protocol 执行等价 runtime calls；
- session usage 与 audit fields 兼容；
- reduced capabilities 必须可见，不得隐式降级。

## Trust And Safety Baseline

- local-first 默认。
- 写入 profile、修改全局规则、破坏性治理动作都需要明确 consent。
- install/profile 变更需要 audit。
- Attach assets 不允许隐藏 mutation。

## 激活完成度检查

- installed-but-unused sessions 可检测。
- delivered / used / skipped / unverifiable 是不同状态。
- Gateway 与 non-Gateway runs 可在 benchmark 输出中对比。
- 即使 agent 已集成，也能解释为什么没有使用记忆。
