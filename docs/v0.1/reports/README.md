# v0.1 Reports

本目录用于后续 v0.1 执行报告、review 报告和 fix-loop 报告。

## Existing Reports

- [ALA-R0 Source Extraction Report](ALA-R0-source-extraction-report.md) - closes
  the R0 docs/source preflight gate; does not claim runtime readiness.
- [ALA-R1 Runtime Truth Kernel Report](ALA-R1-runtime-truth-kernel-report.md) -
  closes the verified R1 package/runtime/storage/audit/doctor baseline; does
  not claim MCP, Attach/Profile, Gateway, recall/provider, Inspector,
  benchmark, or full product readiness.
- [ALA-R2/R3/R4 Foundation Contracts Report](ALA-R2-R3-R4-foundation-contracts-report.md) -
  closes the verified Memory Ontology/Evidence, Structure Registry/Paths, and
  Governance/Promotion foundation slice; does not claim MCP, Attach/Profile,
  Gateway, recall/provider, Inspector, benchmark, or full product readiness.
- [ALA-R5/R6/R7 Runtime Use Proof Report](ALA-R5-R6-R7-runtime-use-proof-report.md) -
  documents the locally verified Recall/Context, Provider/Proposal, and
  Session Audit/Trust runtime contract slice while final post-fix review
  acceptance is pending; does not claim MCP, Attach/Profile, Gateway, real
  external provider adapters, Inspector, benchmark, or full product readiness.
- [ALA-R8/R9 Activation Operations Report](ALA-R8-R9-activation-operations-report.md) -
  documents the Agent Integration and Operations/Portability contract slice:
  integration operation descriptors, MCP descriptors, CLI fallback,
  Attach/Profile preview/confirm, Gateway envelope, profile/secret/provider
  status, portable bundle, backup metadata, and read-only operations status;
  does not claim live daemon, live MCP transport, real profile file mutation,
  Gateway runner, real external provider adapters, Inspector, benchmark, or
  full product readiness.

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
