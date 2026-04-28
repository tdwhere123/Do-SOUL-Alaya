# Runtime Status

Last reviewed: 2026-04-28.

本页记录当前可验证的运行状态。它不负责规划未来实现，只负责陈述当前 readiness 边界。

## Current State

| Area | Status | Evidence |
|---|---|---|
| Product naming | display name set | 使用 `Do-SOUL Alaya`，namespace target `@do-soul/alaya` |
| Stable truth layer | handbook-current | `docs/handbook/**` owns architecture, surface strategy, workflow, status |
| Execution planning | v0.1-planning | `docs/v0.1/**` owns task planning, not current implementation facts |
| Repository mode | Runtime use proof contracts | 旧实现已删除；当前以独立 ALA-R1-R7 package/runtime contracts + handbook + v0.1 planning + archive 为主 |
| Package surface | `r1-baseline-ready` | `package.json` defines private `@do-soul/alaya` package with `build`, `test`, exports, and doctor bin |
| Runtime/API | `runtime-use-proof-ready` | `src/index.ts` exports `createAlayaRuntime(...)` and `AlayaRuntimePort`; public state changes cover R1 audited decisions, R2-R4 foundation operations, and R5/R6/R7 recall context, memory visibility governance, provider proposal, and session trust operations while callback-based audited mutation orchestration stays internal |
| Storage/migration | `runtime-use-proof-ready` | `src/storage/sqlite.ts` is internal, initializes `alaya.sqlite`, `alaya_migrations`, audit tables, ordered `002-ontology` through `008-runtime-use-proof-lineage-replay` migrations, FTS recall index, context pack records, provider/proposal records, session trust records, and replay/lineage fingerprints |
| Doctor CLI / status | `runtime-use-proof-ready` | `dist/cli/index.js doctor --data-dir ...` emits JSON with package/runtime/storage/ontology/structure/governance/recall/provider/session_trust `ok`, profile `not_implemented`, and `product_ready: false` |
| MCP adapter | `not-implemented` | 当前仓库无 MCP server/tools/resources/prompts implementation |
| CLI protocol / Attach/Profile / Gateway | `not-implemented` | 当前仓库只有 doctor CLI；无 CLI protocol adapter、profile installer 或 Gateway runner |
| Recall/provider/session usage proof | `runtime-use-proof-ready` | 当前仓库有 R5 recall/context pack plus runtime-owned memory visibility governance and context-pack replay、R6 provider selection/proposal-only records plus replay/lineage fingerprints、R7 session lifecycle/delivery/proof/trust summary implementation plus context-pack/proposal lineage checks；真实外部 provider adapter 与 agent integration 仍属于后续卡 |
| Inspector / benchmark | `not-implemented` | 当前仓库无展示面板或 benchmark harness |
| Build/Test/Run readiness | `runtime-use-proof-ready` | R1-R7 gate verified with `rtk pnpm build`, `rtk pnpm test`, doctor smoke, import scan, and `rtk git diff --check` |

## Readiness Labels

- `not-implemented`: 该能力在当前仓库没有实现承载。
- `not-ready`: 无法给出可运行声明，任何“可跑通”描述都需要先有实现与验证证据。
- `r1-baseline-ready`: ALA-R1 的 package/runtime/storage/audit/doctor 基线已实现并通过当前 gate；不等于完整产品 ready。
- `foundation-contracts-ready`: ALA-R2/R3/R4 ontology、structure、governance foundation contracts 已实现并通过当前 package gate；不等于 recall/provider/adapter/full product ready。
- `runtime-use-proof-ready`: ALA-R5/R6/R7 recall/context、provider/proposal、session trust contracts 已实现并通过当前 package gate；不等于 MCP/Attach/Profile/Gateway/full product ready，也不表示真实外部 provider adapter 已接入。
- `handbook-current`: 当前稳定语义和边界由 handbook 维护。
- `v0.1-planning`: 执行规划材料，不能单独证明实现存在。
- `archived-reference-only`: 仅存在历史材料，不可视作当前运行事实。

## What This Page Must Not Claim

- 不把 archive 中的旧命令写成“当前可执行”。
- 不把历史评审结论写成“当前已通过”。
- 不把目标命名空间 `@do-soul/alaya` 误写为“已发布包事实”。
- 不把 surface strategy 写成 MCP/CLI/Gateway/Inspector 已经实现。
- 不把 v0.1 执行排序或任务卡退出条件写成当前 build/test/run 通过。
- 不把 ALA-R1 doctor 的 `r1_baseline_ready: true`、ALA-R2/R3/R4 doctor 的 `foundation_contracts_ready: true`，或 ALA-R5/R6/R7 doctor 的 `runtime_use_proof_ready: true` 写成完整产品 ready、agent adapter ready、MCP ready、Gateway ready 或真实外部 provider adapter ready。

## Current Verification Boundary

ALA-R1 以后，build/test gates 适用于当前 root package/runtime contracts。当前可执行的 R1-R7 gate 是：

- `rtk pnpm install`
- `rtk pnpm build`
- `rtk pnpm test`
- `rtk node dist/cli/index.js doctor --data-dir /tmp/do-soul-alaya-smoke`
- `rtk rg -n "@do-what/|do-what-new/packages" package.json src`
- `rtk git diff --check`

R1-R7 gate 只能证明 package/runtime/storage/audit/doctor plus ontology/structure/governance/recall/provider-proposal/session-trust contracts。MCP、Attach/Profile、Gateway、真实外部 provider adapter、Inspector、benchmark 和 full product loop 仍需后续 cards。

## Transition Gate (Toward Product Readiness)

只有在以下条件同时满足后，状态才可从 `runtime-use-proof-ready` 上调到更高产品 readiness：

1. 新实现路径已落地（runtime 边界与至少一个 agent-facing adapter）。
2. 可重复验证命令在当前仓库通过，并有报告记录。
3. Build/test/smoke gates 与新 package surface 对齐，而不是复用旧 prototype 命令。
4. `code-map.md` 与本页已同步更新，且不引用 archive 作为运行证据。
