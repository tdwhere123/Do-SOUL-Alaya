# ALA-R11 - Graph Inspector Contract

## Goal

冻结 Phase 2 点状连接图的数据契约：graph/topology 是 read-only derived view，来自 runtime/API，不拥有 durable truth。

## Source References

- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/soul/graph.ts:8`
- `/home/tdwhere/vibe/do-what-new/packages/protocol/src/soul/soul-topology.ts:19`
- `/home/tdwhere/vibe/do-what-new/apps/core-daemon/src/routes/soul-graph.ts:22`
- `/home/tdwhere/vibe/do-what-new/apps/core-daemon/src/routes/soul.ts:62`
- `/home/tdwhere/vibe/do-what-new/apps/core-daemon/src/services/soul-topology-audit-service.ts:23`
- `/home/tdwhere/vibe/do-what-new/packages/ui-sdk/src/client.ts:871`
- `/home/tdwhere/vibe/do-what-new/packages/soul/src/garden/topology-service.ts:49`
- `/home/tdwhere/vibe/do-what-new/docs/handbook/runtime-status.md:266`

## Alaya Adaptation

- Graph inspector uses typed nodes/edges with bounded depth/limit。
- topology derives from active PathRelation and optional snapshot/trend overlays。
- query can be audited, but read must not mutate PathRelation or durable memory。

## Non-goals

- 不实现 visual UI。
- 不选择 Sigma.js/graph library。
- 不提供 graph mutation。

## Scope

- graph API contracts。
- topology query params。
- overlays: evidence/path/governance/session/provider/degradation。
- truncation/totals。
- audit event contract。

## Inputs

- workspace/user/project scope。
- graph query params。
- overlay filters。

## Outputs

- graph nodes/edges。
- topology summary。
- overlay metadata。
- truncation/totals。
- read audit event。

## Acceptance

- graph/topology endpoints are read-only。
- data derives from runtime/API and active PathRelation。
- Inspector cannot create/update/delete durable truth。
- bounded query params prevent unbounded graph reads。
- overlays can answer trust/debug questions without becoming truth。

## Verification

- graph contract tests。
- bounded query tests。
- read-only mutation regression tests。
- overlay snapshot tests。

## Review Lens

- derived-view boundary。
- graph contract stability。
- future UI readiness。

## Stop Conditions

- If graph code introduces independent graph storage as truth, stop and redesign.
