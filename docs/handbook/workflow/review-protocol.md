# Review Protocol

本页定义 handbook/实现评审时的统一协议。默认采用 Findings First。

## Findings First

按严重级别先报问题，再给摘要：

- Blocking：架构边界违背、验收未满足、会导致错误执行的文档矛盾、或虚假 readiness 声明。
- Important：高概率缺陷、回归风险、关键覆盖缺失、或会误导操作者的状态描述。
- Nice-to-have：低风险清理与可读性改进。

## Evidence Requirements

每条 finding 必须包含：

- 文件路径与定位（行号或段落锚点）。
- 观察到的现状（Observed）。
- 期望状态（Expected）及依据规则。
- 复现或核查方式（Repro/Witness）。

对于文档评审，`Repro/Witness` 可以是可复核的 grep/read 命令与输出依据。

## Review Finding Record

使用如下结构（任意严重级别都必须完整）：

    ID: <B1 / I1 / N1 ...>
    Severity: <Blocking | Important | Nice-to-have>
    Headline: <一句话问题陈述>
    Location: <file + line/section>
    Observed: <当前情况>
    Expected: <应有情况 + 依据>
    Repro/Witness: <最小复核步骤>

## Checklist

- 范围是否严格在授权写入文件内。
- 术语是否与 `glossary.md` 一致。
- `code-map.md` 是否只陈述当前存在/缺失事实。
- `runtime-status.md` 是否避免 build/test/run readiness 误报。
- `architecture.md` 是否保持 runtime/API 是 durable truth gate，且 adapter/provider/Inspector/benchmark 不直接写 durable truth。
- `surface-strategy.md` 是否把 MCP/CLI/Attach/Gateway/Inspector 写成策略边界，而不是已实现事实。
- workflow 文档是否包含 `BLOCKED` 出口与证据纪律。
- handbook 是否避免链接或依赖 v0.1 execution ordering docs 作为当前真相。
- 是否把 archive 当成了当前实现（若有则至少 Important，通常 Blocking）。

## Handbook Stable-Truth Review

评审 handbook docs-truth 变更时，必须分开判断四类内容：

| Layer | Acceptable claim | Finding trigger |
|---|---|---|
| Product positioning | 本地优先 CLI agent memory core，namespace target，surface direction | 写成已发布包、已实现命令或已接入 agent |
| Architecture/runtime | 三层四轴、runtime-only durable write、source/evidence/governance | 允许 adapter/provider/UI 直接 durable write |
| Surface strategy | MCP-first、CLI fallback、Attach/Profile、Gateway、Inspector/benchmark 的边界 | 声称这些 surface 当前可运行 |
| Runtime status | ALA-R1 baseline readiness、未实现 surface 明确保留 `not-implemented`、build/test gate 只绑定当前 root package/runtime baseline | 声称 MCP/Attach/Profile/Gateway/recall/provider/Inspector/full product 已通过或可执行 |

若 v0.1 source material 与 handbook/invariants 冲突，finding 至少为 Blocking，除非变更明确保留 handbook 优先级并没有吸收冲突内容。

## Fix Loop Rule

- 所有 Blocking/Important 必须修复后再复审。
- Nice-to-have 默认也修复；若暂缓，必须记录原因与后续追踪项。
- Worker 的 `DONE` 不是验收结论；只有复审通过才可关闭任务。
