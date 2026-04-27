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
- workflow 文档是否包含 `BLOCKED` 出口与证据纪律。
- 是否把 archive 当成了当前实现（若有则至少 Important，通常 Blocking）。

## Fix Loop Rule

- 所有 Blocking/Important 必须修复后再复审。
- Nice-to-have 默认也修复；若暂缓，必须记录原因与后续追踪项。
- Worker 的 `DONE` 不是验收结论；只有复审通过才可关闭任务。
