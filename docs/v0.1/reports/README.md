# v0.1 Reports

本目录用于后续 v0.1 执行报告、review 报告和 fix-loop 报告。

## Existing Reports

- [ALA-R0 Source Extraction Report](ALA-R0-source-extraction-report.md) - closes
  the R0 docs/source preflight gate; does not claim runtime readiness.

## Placement Rules

- 单卡执行报告使用 `ALA-Rx-<short-name>-report.md`。
- review 报告使用 `ALA-Rx-<short-name>-review.md`。
- fix-loop 报告使用 `ALA-Rx-<short-name>-fix-loop.md`。
- 跨卡 integration 报告使用 `integration-<scope>-report.md`。

## Evidence Rules

- 报告必须引用对应 task card、source references、verification、review lens。
- 当前实现/package surface 缺席时，只能写 planned commands 或 inspection
  evidence，不得声称 build/test/CLI/MCP/smoke 命令已经通过。
- 报告不能替代 handbook。稳定 product/architecture/current-truth 变化应由父任务
  在 `docs/handbook/` 中单独处理。
