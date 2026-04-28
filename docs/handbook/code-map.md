# Code Map

本页记录当前仓库中“真实存在且可定位”的代码与文档版图。
当前事实：仓库处于 reset/extraction 后的 ALA-R1-R9 runtime/activation/operations contracts；旧原型实现已删除，当前可执行代码覆盖 root package、runtime/API、audit-first mutation、internal storage migrations、doctor CLI、Memory Ontology/Evidence、Structure Registry/Paths、Governance/Promotion、Recall/Context、Provider/Proposal、Session Audit/Trust、Integration/MCP/CLI fallback、Attach/Profile、Gateway、Operations/Portability 和 focused tests。

## Top Level (Current)

```text
package.json
pnpm-lock.yaml
tsconfig.json
vitest.config.ts
src/
  index.ts
  package-info.ts
  cli/
    fallback.ts
    doctor.ts
    index.ts
  doctor/
    report.ts
  foundation/
    types.ts
    validation.ts
  governance/
    index.ts
    policy.ts
    promotion-gate.ts
    types.ts
  gateway/
    envelope.ts
    index.ts
  integration/
    index.ts
    operations.ts
  mcp/
    index.ts
    surface.ts
  operations/
    backup.ts
    index.ts
    portable.ts
    status.ts
    types.ts
  profile/
    attach.ts
    index.ts
  provider/
    index.ts
    status.ts
  recall/
    context-pack.ts
    embedding.ts
    index.ts
    lexical.ts
    path.ts
    shared.ts
    types.ts
  session/
    index.ts
    trust.ts
    types.ts
    validation.ts
  secrets/
    index.ts
  ontology/
    index.ts
    types.ts
    validation.ts
  runtime/
    audit-types.ts
    audited-mutation.ts
    json.ts
    redaction.ts
    runtime.ts
    types.ts
  storage/
    sqlite.ts
  structure/
    index.ts
    manifestation.ts
    topology.ts
    types.ts
    validation.ts
  __tests__/
    audited-mutation.test.ts
    backup-contract.test.ts
    cli-fallback-contract.test.ts
    doctor-cli.test.ts
    gateway-envelope.test.ts
    governance.test.ts
    helpers.ts
    import-export-integrity.test.ts
    integration-operations.test.ts
    mcp-surface.test.ts
    ontology-runtime.test.ts
    operations-status.test.ts
    portable-bundle.test.ts
    profile-attach-contract.test.ts
    profile-config.test.ts
    public-api-boundary.test.ts
    provider-proposal.test.ts
    provider-status.test.ts
    recall-context.test.ts
    runtime-port.test.ts
    runtime-use-proof.test.ts
    session-trust.test.ts
    secret-ref.test.ts
    storage.test.ts
    structure.test.ts
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
      ALA-R1-runtime-truth-kernel-report.md
      ALA-R2-R3-R4-foundation-contracts-report.md
      ALA-R5-R6-R7-runtime-use-proof-report.md
      ALA-R8-R9-activation-operations-report.md
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
| Package surface | `r1-baseline-ready` | `package.json` owns `@do-soul/alaya`, build/test scripts, exports, and doctor bins |
| Runtime/API boundary | `activation-operations-contract-ready` | `src/index.ts`, `src/runtime/runtime.ts`, `src/runtime/types.ts` expose `createAlayaRuntime(...)`, `AlayaRuntimePort`, R1 audited decisions, R2 ontology writes, R3 path/manifestation/topology operations, R4 governance decisions, R5 context assembly and memory visibility governance, R6 provider/proposal records, R7 session trust operations, and R8/R9 adapter/operations helpers while storage stays internal |
| Audit-first mutation | `r1-baseline-ready` | `src/runtime/audited-mutation.ts` records intent before mutation, committed after mutation, and notification status after notify |
| Storage | `runtime-use-proof-ready` | `src/storage/sqlite.ts` is internal storage; initializes `alaya.sqlite`, migration metadata, audit events, ontology records, path relations, governance records, recall FTS/context pack records, provider/proposal records, session trust records, and replay/lineage columns through migration `008` |
| Ontology/Evidence | `foundation-contracts-ready` | `src/ontology/**` defines Alaya-owned `EvidenceCapsule`, `MemoryEntry`, `SynthesisCapsule`, `ClaimForm` contracts and validators |
| Structure/Paths | `foundation-contracts-ready` | `src/structure/**` defines `PathRelation`, runtime-only `ActivationCandidate`, manifestation resolver, and read-only topology projection |
| Governance/Promotion | `foundation-contracts-ready` | `src/governance/**` defines promotion gate, HITL/operator reason policy, and bypass fail-closed signal |
| Recall/Context | `runtime-use-proof-ready` | `src/recall/**` defines structured/lexical/path-aware recall merge, opt-in embedding supplement degradation, runtime-owned memory visibility exclusion, runtime-only context pack, replay-safe context pack lineage, exclusions, and data-not-instructions delivery text |
| Provider/Proposal | `runtime-use-proof-ready` | `src/provider/**` defines provider capability selection, health/degradation semantics, proposal-only records, provider-decision lineage, replay fingerprints, rejected proposal normalization, and background proposal job summaries |
| Session Audit/Trust | `runtime-use-proof-ready` | `src/session/**` defines session lifecycle events, context delivery records, usage proof records, context-pack/proposal lineage validation, trust summary derivation, and late terminal handling where delivered does not imply used |
| Integration/MCP surface | `activation-operations-contract-ready` | `src/integration/**` and `src/mcp/**` define operation descriptors, MCP tool/resource/prompt descriptors, and injected-runtime invocation helpers without live transport/server |
| CLI fallback / Attach/Profile / Gateway | `activation-operations-contract-ready` | `src/cli/fallback.ts`, `src/profile/**`, and `src/gateway/**` define fallback request normalization, Attach/Profile preview/confirm/result contracts, and Gateway audit/strict envelope helpers; doctor remains the only executable CLI command |
| Operations/Portability | `activation-operations-contract-ready` | `src/operations/**`, `src/secrets/**`, and `src/provider/status.ts` define portable bundle validation, backup metadata, read-only operations status, secret refs without raw secret serialization, and provider/embedding status derivation |
| Doctor CLI/status | `activation-operations-contract-ready` | `src/cli/index.ts`, `src/cli/doctor.ts`, `src/doctor/report.ts` produce doctor JSON through runtime service with `activation_operations_ready: true` while `product_ready` remains false |
| Tests | `activation-operations-contract-ready` | `src/__tests__/*.test.ts` cover storage init/idempotency, audit success/failures, doctor, public API boundary, ontology rejects, structure behavior, governance policy, recall/context, provider/proposal, session trust, runtime use proof integration, integration/MCP surface, CLI fallback, Attach/Profile, Gateway, profile/secret/provider status, and operations/portability |
| Live daemon/MCP transport/Profile writes/Gateway runner/HTTP/Inspector/Bench | `not-implemented` | No live daemon, MCP transport server, profile file mutation runner, Gateway runner, HTTP surface, Inspector, or benchmark harness exists |
| External provider adapters | `not-implemented` | Provider capability/proposal contracts exist, but no concrete external provider SDK adapter is implemented |
| Build/Test wiring | `activation-operations-contract-ready` | `tsconfig.json`, `vitest.config.ts`, `pnpm-lock.yaml`, and R1-R9 verification gate |

## Archive Boundary

- `docs/archive/2026-04-27-old-prototype/**` 是历史快照。
- Archive 可用于背景对照，不可当作“当前已实现”。
- 若需要恢复或迁移历史能力，应先由任务卡明确范围，再在新实现路径落地并更新本页。

## Update Rules

- 当新增任何实际代码路径（例如 `src/` 或 adapter 目录）时，必须同步更新本页。
- 本页只写“当前存在”与“当前缺失”，不写未来计划。
