# Code Map

本页记录当前仓库中“真实存在且可定位”的代码与文档版图。
当前事实：仓库处于 docs reset；旧原型实现已删除，未保留可执行 runtime、适配器或存储实现。

## Top Level (Current)

```text
docs/
  README.md
  handbook/
    README.md
    architecture.md
    surface-strategy.md
    invariants.md
    glossary.md
    code-map.md
    extraction-source-map.md
    runtime-status.md
    workflow/
      agent-workflow.md
      review-protocol.md
  v0.1/
    README.md
    reports/
      README.md
      ALA-R0-source-extraction-report.md
    task-cards/
      README.md
      ALA-R0 through ALA-R12 root task cards
  archive/
    2026-04-27-old-prototype/
      product/
      interfaces/
      implementation/
      reviews/
```

## Implementation Coverage

| Area | Current status | Evidence anchor |
|---|---|---|
| Runtime/API boundary | `not-implemented` | 当前树无可执行实现目录 |
| Storage | `not-implemented` | 当前树无存储实现代码 |
| Adapters (CLI/HTTP/MCP/Inspector/Bench) | `not-implemented` | 当前树无对应实现目录 |
| Build/Test wiring | `not-implemented` | 当前无可用于构建测试的实现面 |

## Archive Boundary

- `docs/archive/2026-04-27-old-prototype/**` 是历史快照。
- Archive 可用于背景对照，不可当作“当前已实现”。
- 若需要恢复实现，应先由任务卡明确范围，再在新实现路径落地并更新本页。

## Update Rules

- 当新增任何实际代码路径（例如 `src/` 或 adapter 目录）时，必须同步更新本页。
- 本页只写“当前存在”与“当前缺失”，不写未来计划。
