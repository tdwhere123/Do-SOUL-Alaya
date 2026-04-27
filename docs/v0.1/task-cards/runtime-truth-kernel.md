# ALA-R1 - Runtime Truth Kernel

## Goal

建立 `@do-soul/alaya` 的独立 package、runtime/API boundary、storage migration baseline、doctor 和 auditable write discipline。

## Source References

- `/home/tdwhere/vibe/do-what-new/docs/handbook/invariants.md:7`
- `/home/tdwhere/vibe/do-what-new/docs/handbook/invariants.md:22`
- `/home/tdwhere/vibe/do-what-new/docs/handbook/invariants.md:27`
- `/home/tdwhere/vibe/do-what-new/packages/core/src/event-publisher.ts:35`
- `/home/tdwhere/vibe/do-what-new/packages/core/src/event-publisher.ts:112`
- `/home/tdwhere/vibe/do-what-new/docs/handbook/code-map.md:15`
- `/home/tdwhere/vibe/do-what-new/docs/handbook/code-map.md:90`

## Source Classification

- `source-backed`: durable truth 只能经 runtime/control boundary；EventLog-first
  mutation discipline 和 protocol/core/storage/app 切分来自 do-what-new
  invariant、code-map 与 EventPublisher source。
- `alaya-adapted`: Alaya 采用独立 package namespace、runtime/API shape、
  storage migration baseline 和 doctor/status surface；不得继承 do-what-new
  package names or runtime imports。
- `alaya-default`: 本卡不新增产品体验默认值；doctor/status 字段只服务 v0.1
  operator readiness，不覆盖 centralized defaults。
- 禁止误用：不能让 MCP/CLI/adapter 直接写 storage；不能把 do-what-new
  monorepo dependency graph 搬进 `@do-soul/alaya`。

## Dependencies

- ALA-R0 source/doc preflight.
- Handbook invariants for durable truth, audit, adapter boundary, and no
  `@do-what/*` runtime imports.

## Parallel With

- None for the runtime/API and storage boundary itself.
- ALA-R2 through ALA-R4 may prepare contract reviews only after this card's
  public runtime/API boundary is stable.

## Write Ownership

- Planned package metadata, runtime/API boundary, storage migration baseline,
  audit writer abstraction, doctor/status surface, and focused tests.
- Do not own MCP/CLI/Gateway feature behavior, full ontology implementation, or
  Inspector delivery from this card.

## Acceptance

- package/runtime skeleton includes build/test/doctor verification gates, with
  results recorded only after package surface exists.
- adapters 没有直接 storage write path。
- audit-first mutation helper 覆盖成功、mutation 失败、notification 失败路径。
- 不存在 `@do-what/*` runtime dependency。

## Verification

- Planned after package surface exists: `rtk pnpm build`
- Planned after package surface exists: `rtk pnpm test`
- Planned after CLI surface exists:
  `rtk node dist/cli/index.js doctor --data-dir /tmp/do-soul-alaya-smoke`
- Planned import scan after source exists:
  `rtk rg -n "@do-what/|do-what-new/packages" package.json src`

## Review Lens

- architecture boundary。
- install/release readiness。
- storage migration safety。

## Stop Conditions

- 如果需要新增 dependency，必须说明本地 package 理由。
- 如果 runtime/API 与 durable truth 边界不清，先停止并修 docs/card。

## Implementation Subcards

### ALA-R1.1 - Package Runtime API Skeleton

#### Scope

建立 `@do-soul/alaya` package metadata、runtime public API module、adapter-facing
interface 和禁止 direct storage write 的 module boundary。

#### Source References

- `source-backed`: invariants durable truth boundary and code-map package split。
- `alaya-adapted`: package name、entrypoints、API naming are Alaya-owned。

#### Acceptance

- package metadata targets `@do-soul/alaya`。
- runtime/API exposes state-changing operations through one boundary。
- adapters can compile only against runtime/API contracts, not storage repos。

#### Verification

- Planned: `rtk pnpm build`
- Planned: `rtk rg -n "@do-what/|do-what-new/packages" package.json src`
- Boundary review of imports after implementation exists。

#### Review Lens

- architecture boundary。
- package contract clarity。
- no do-what runtime dependency。

#### Stop Conditions

- Stop if API shape allows adapter-owned durable writes。
- Stop if implementation imports `@do-what/*` or do-what-new package paths。

### ALA-R1.2 - Storage Migration Baseline

#### Scope

Create storage module and migration runner baseline for Alaya-owned durable
tables without restoring old prototype implementation files.

#### Source References

- `source-backed`: do-what-new storage/package layering and migration discipline。
- `alaya-adapted`: table names and migration numbering are Alaya-owned。

#### Acceptance

- migration runner can initialize a clean data dir。
- storage tables are reachable only through runtime-owned services。
- migration metadata is auditable and portable。

#### Verification

- Planned: storage migration tests。
- Planned: clean data-dir doctor smoke。
- Import scan confirms storage repos are not adapter dependencies。

#### Review Lens

- migration safety。
- durable truth ownership。
- reset-state discipline。

#### Stop Conditions

- Stop if the change restores deleted prototype source.
- Stop if migration state cannot be recreated from a clean data dir。

### ALA-R1.3 - Audit-First Mutation Helper

#### Scope

Implement a reusable mutation helper for append audit intent, mutate durable
state, and propagate notification/reporting without losing failure evidence.

#### Source References

- `source-backed`: EventPublisher append/mutate/propagate ordering in do-what-new。
- `alaya-adapted`: event names and payloads are Alaya-owned。

#### Acceptance

- success path records audit and durable mutation。
- mutation failure keeps audit evidence and returns deterministic error。
- notification failure is observable without pretending durable mutation failed。

#### Verification

- Planned: success, mutation-failure, and notification-failure tests。
- Planned: audit event snapshot tests。

#### Review Lens

- trust/audit completeness。
- failure-mode correctness。
- deterministic ordering。

#### Stop Conditions

- Stop if any durable mutation can occur before the audit intent is recorded。
- Stop if notification failure silently hides an otherwise committed mutation。

### ALA-R1.4 - Doctor Status Baseline

#### Scope

Provide a doctor/status baseline for package/runtime/storage/profile/provider
readiness, with no claims beyond implemented surfaces.

#### Source References

- `source-backed`: do-what-new host prerequisite/status discipline。
- `alaya-adapted`: Alaya status categories match its daemon/profile/provider model。

#### Acceptance

- doctor reports package/runtime/storage/profile/provider status。
- unavailable or unimplemented surfaces are explicit, not omitted。
- status output redacts secrets and does not imply agent usage proof。

#### Verification

- Planned: `rtk node dist/cli/index.js doctor --data-dir /tmp/do-soul-alaya-smoke`
- Planned: doctor snapshot tests。

#### Review Lens

- local usability。
- install/release readiness。
- truthful readiness language。

#### Stop Conditions

- Stop if doctor reports success for a surface that has no implementation.
- Stop if status output leaks secret values.
