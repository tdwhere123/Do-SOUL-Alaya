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

## Alaya Adaptation

- `packages/protocol/core/soul/storage/apps` 的职责拆分可作为架构来源，但 Alaya 不继承 do-what package。
- Alaya runtime 是 durable truth gate；adapters 只能调用 runtime。
- 所有 state-changing writes 必须有 audit-first 纪律：先记录审计意图，再修改 durable state，再通知/广播。

## Non-goals

- 不接 MCP/CLI/Gateway 完整行为。
- 不实现完整 ontology。
- 不实现 Inspector。

## Scope

- package skeleton。
- runtime public API skeleton。
- storage migration baseline。
- event/audit writer abstraction。
- doctor command。

## Inputs

- `docs/handbook/architecture.md`
- `docs/handbook/invariants.md`
- `docs/v0.1/extraction-ledger.md`

## Outputs

- `package.json` 使用 `@do-soul/alaya`。
- runtime/API module。
- storage module + migration runner。
- doctor 能报告 package/runtime/storage/profile/provider 状态。

## Acceptance

- build/test/doctor 可运行。
- adapters 没有直接 storage write path。
- audit-first mutation helper 覆盖成功、mutation 失败、notification 失败路径。
- 不存在 `@do-what/*` runtime dependency。

## Verification

- `rtk pnpm build`
- `rtk pnpm test`
- `rtk node dist/cli/index.js doctor --data-dir /tmp/do-soul-alaya-smoke`
- `rtk rg -n "@do-what/|do-what-new/packages" package.json src`

## Review Lens

- architecture boundary。
- install/release readiness。
- storage migration safety。

## Stop Conditions

- 如果需要新增 dependency，必须说明本地 package 理由。
- 如果 runtime/API 与 durable truth 边界不清，先停止并修 docs/card。
