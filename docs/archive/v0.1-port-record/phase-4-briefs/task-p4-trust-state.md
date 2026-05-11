# Implementation Brief: Task P4-trust-state — Implement delivered-not-used trust state

> - **Phase**: 4
> - **Wave**: 4
> - **Card ID**: P4-trust-state
> - **Port mode**: requires-redesign
> - **Source**: `n/a`
> - **Target**: `packages/protocol/src/soul/trust-state.ts`, `packages/protocol/src/__tests__/trust-state.test.ts`, `apps/core-daemon/src/trust-state.ts`, `apps/core-daemon/src/__tests__/trust-state.test.ts`
> - **Size**: M
> - **Prerequisite**: P4-daemon-startup-ordering
> - **Blocks**: P4-mcp-memory-tools, P4-cli-status, Gate-4 demo
> - **Closing readiness label**: live-event-ready
> - **Owner**: unassigned

## 0. Charter Authority

`docs/v0.1/phase-4-briefs/README.md` row "P4-trust-state";
`docs/handbook/port-protocol.md §3 requires-redesign`;
`docs/handbook/invariants.md §20` ("Delivered ≠ used") — the load-bearing invariant for this card;
`docs/handbook/architecture.md §Trust Model` — defines the seven trust states (installed / configured / delivered / used / skipped / unverifiable / mixed).

This card is `requires-redesign` because there is no upstream do-what-new analogue: the trust state model is Alaya-original, motivated by the fact that consuming agents (Codex, Claude Code) deliver context and may or may not actually consume it — Alaya cannot infer usage from delivery alone.

## 1. Background & Goal

**Background**: This card is part of the v0.1 port-first task-card set and exists to assign exact source ownership before implementation dispatch.

**Goal**: Deliver implement delivered-not-used trust state for
ContextDeliveryRecord and UsageProofRecord consumers.

## 2. Allowed Scope

### 2.1 File Ownership

| Source | Target | Port requirement |
|---|---|---|
| `n/a` | `packages/protocol/src/soul/trust-state.ts` | New zod schemas (see §2.3 schema table); export from `packages/protocol/src/index.ts` (this card owns this barrel exception per §6). |
| `n/a` | `packages/protocol/src/__tests__/trust-state.test.ts` | Schema parse/serialize tests for each record + each state enum value. |
| `n/a` | `apps/core-daemon/src/trust-state.ts` | In-memory `TrustStateRecorder` class implementing the §2.3 behavior contract. |
| `n/a` | `apps/core-daemon/src/__tests__/trust-state.test.ts` | Tests proving every §2.3 acceptance behavior. |
| `n/a` | `packages/storage/src/migrations/056-trust-state-persistence.sql` | New forward-only SQLite migration for `trust_context_delivery` and `trust_usage_proof` tables; authorized by `task-p1-migrations-followup-trust-state-056.md` and `#BL-022`. |
| `n/a` | `packages/storage/src/repos/trust-state-repo.ts` | New `TrustStatePersistenceRepoPort` implementation backing the recorder; authorized by `task-p1-migrations-followup-trust-state-056.md` and `#BL-022`. |

### 2.2 Port Rules

- Port mode is `requires-redesign`; implementation must follow `docs/handbook/port-protocol.md` for that mode.
- Rewrite `@do-what/*` imports to `@do-soul/alaya-*` where applicable.
- Do not edit shared barrels unless this card explicitly owns that barrel; this card is the single explicit exception that updates `packages/protocol/src/index.ts` to export the new schemas.
- If a cited source path is missing or a source dependency forces files outside §2, return `BLOCKED` instead of expanding scope.
- **Original P4 scope** kept persistence in-memory only. SQL durability
  for delivery / usage records across daemon restart was deferred to
  backlog #BL-015; the follow-up repair added migration
  `056-trust-state-persistence.sql` and closed #BL-015 for
  delivery/usage durability. Installed / configured / unverifiable
  counter persistence was tracked separately by `#BL-020` and is now
  closed by EventLog-backed startup replay before recorder readiness.
- **EventPublisher divergence**: the #BL-015 repair intentionally keeps
  `publishWithMutation(event, mutate(entry))` instead of the vendor
  zero-argument callback so delivery / usage rows can store the exact
  EventLog `event_id` as `audit_event_id`. The divergence is registered
  by `#BL-021` and `docs/handbook/port-protocol.md`.

### 2.3 Schema Contract (in `packages/protocol`)

```ts
// packages/protocol/src/soul/trust-state.ts
import { z } from "zod";
import { NonEmptyStringSchema } from "../schema-primitives.js";
import { SoulContextUsageStateSchema } from "./mcp-types.js";

export const TrustStateSchema = z.enum([
  "installed",       // attach config exists; no session yet
  "configured",      // agent reports configured (handshake completed); no delivery yet
  "delivered",       // Alaya delivered context (one or more soul.recall calls returned)
  "used",            // agent reported used via soul.report_context_usage
  "skipped",         // agent reported skipped
  "unverifiable",    // session ended without any usage report
  "mixed"            // multiple deliveries with different outcomes
]);
export type TrustState = z.infer<typeof TrustStateSchema>;

export const ContextDeliveryRecordSchema = z.object({
  delivery_id: NonEmptyStringSchema,        // matches SoulMemorySearchResponseSchema.delivery_id
  agent_target: NonEmptyStringSchema,       // "codex" | "claude-code" | future
  workspace_id: NonEmptyStringSchema.nullable(),
  run_id: NonEmptyStringSchema.nullable(),
  delivered_object_ids: z.array(NonEmptyStringSchema).readonly(),
  delivered_at: z.string().datetime(),      // ISO 8601
  audit_event_id: NonEmptyStringSchema      // EventLog id of memory.delivered event
}).readonly();
export type ContextDeliveryRecord = z.infer<typeof ContextDeliveryRecordSchema>;

export const UsageProofRecordSchema = z.object({
  delivery_id: NonEmptyStringSchema,        // foreign key to ContextDeliveryRecord
  usage_state: SoulContextUsageStateSchema, // "used" | "skipped" | "not_applicable"
  used_object_ids: z.array(NonEmptyStringSchema).readonly(),  // empty for skipped/not_applicable
  reason: z.string().nullable(),
  reported_at: z.string().datetime(),
  audit_event_id: NonEmptyStringSchema      // EventLog id of memory.usage_reported event
}).readonly();
export type UsageProofRecord = z.infer<typeof UsageProofRecordSchema>;

export const TrustSummarySchema = z.object({
  agent_target: NonEmptyStringSchema,
  state: TrustStateSchema,
  installed_count: z.number().int().nonnegative(),
  configured_count: z.number().int().nonnegative(),
  delivered_count: z.number().int().nonnegative(),
  used_count: z.number().int().nonnegative(),
  skipped_count: z.number().int().nonnegative(),
  not_applicable_count: z.number().int().nonnegative(),
  unverifiable_count: z.number().int().nonnegative(),
  last_delivery_at: z.string().datetime().nullable(),
  last_usage_report_at: z.string().datetime().nullable()
}).readonly();
export type TrustSummary = z.infer<typeof TrustSummarySchema>;
```

### 2.4 Behavior Contract (in `apps/core-daemon/src/trust-state.ts`)

`TrustStateRecorder` is constructed at daemon startup step 3 (after EventPublisher is ready) and consumed at step 6 (before MCP transport binds).

**Recorder API** (the original P4 implementation used in-memory maps;
the #BL-015 follow-up now backs delivery/usage records with SQLite):

```ts
class TrustStateRecorder {
  recordDelivery(input: Omit<ContextDeliveryRecord, "audit_event_id">): Promise<ContextDeliveryRecord>;
  recordUsage(input: Omit<UsageProofRecord, "audit_event_id">): Promise<UsageProofRecord>;
  recordInstalled(agent_target: string): Promise<void>;       // called by alaya attach
  recordConfigured(agent_target: string): Promise<void>;      // called on first MCP handshake
  recordUnverifiable(agent_target: string, session_id: string): Promise<void>;  // session terminated without proof
  summarize(agent_target: string): Promise<TrustSummary>;    // for alaya status
}
```

**Mandatory behaviors**:

| # | Behavior | Test name |
|---|---|---|
| B1 | `recordDelivery` calls `EventPublisher.publishWithMutation` with event_type `memory.delivered`; the returned record's `audit_event_id` MUST equal the EventLog entry id | `records delivery via EventPublisher` |
| B2 | `recordUsage` calls `EventPublisher.publishWithMutation` with event_type `memory.usage_reported`; rejects if `delivery_id` is unknown to the recorder | `recordUsage rejects unknown delivery_id` |
| B3 | Multiple `recordDelivery` calls with different `delivery_id` accumulate; `summarize().delivered_count` reflects total | `delivered_count accumulates across calls` |
| B4 | `recordDelivery` followed by no `recordUsage` does NOT increment `used_count` (the load-bearing §20 invariant) | `delivered does not imply used` |
| B5 | `recordUsage` with `usage_state: "used"` increments `used_count` only (not `delivered_count` again) | `usage report does not double-count delivery` |
| B6 | `recordUnverifiable` increments `unverifiable_count` and is callable only after at least one `recordDelivery` for that target | `unverifiable requires prior delivery` |
| B7 | `summarize.state` reduction: see §2.5 reduction table | `summarize state reduction is correct` |
| B8 | All records keep `delivered_at` / `reported_at` as ISO 8601 strings; `Date.now()` MUST be wrapped through an injectable `clock: () => string` for testability | `clock is injectable and used` |
| B9 | Recorder fails closed before daemon startup step 6: any call before EventPublisher is ready throws `TrustStateRecorderNotReady` | `pre-startup calls fail closed` |

### 2.5 State Reduction Table (used by `summarize().state`)

Computed deterministically from counts; ties broken by row order (first match wins):

| Condition | Resulting `state` |
|---|---|
| `delivered_count == 0 && configured_count == 0 && installed_count == 0` | `installed` (no record at all → still treat as installed; covers the never-attached edge) |
| `installed_count > 0 && configured_count == 0` | `installed` |
| `configured_count > 0 && delivered_count == 0` | `configured` |
| `delivered_count > 0 && used_count == 0 && skipped_count == 0 && not_applicable_count == 0 && unverifiable_count == 0` | `delivered` |
| `used_count > 0 && skipped_count == 0` | `used` |
| `skipped_count > 0 && used_count == 0 && not_applicable_count == 0` | `skipped` |
| `unverifiable_count > 0 && used_count == 0 && skipped_count == 0` | `unverifiable` |
| any other combination of `used + skipped + not_applicable + unverifiable > 0` with at least two distinct outcomes | `mixed` |

## 3. Repaired Follow-Ups

- **#BL-015** SQL persistence of delivery / usage trust records across
  daemon restart. Resolved by the 2026-05-01 repair.
- **#BL-020** restart stability of installed / configured /
  unverifiable trust counters. Resolved by EventLog-backed startup replay
  before recorder readiness.

## 4. Acceptance Criteria

| AC | Criteria | Evidence |
|---|---|---|
| AC1 | All behaviors in §2 are implemented exactly as the Alaya redesign states | Targeted tests from §5 prove every listed behavior |
| AC2 | Source is `n/a` (Alaya-original); dispatch precondition is that all targets in §2.1 are absent before dispatch | `rtk node -e "const fs=require('fs');const targets=[\"packages/protocol/src/soul/trust-state.ts\",\"apps/core-daemon/src/trust-state.ts\"];const existing=targets.filter(p=>fs.existsSync(p));if(existing.length){console.error('targets already exist:',existing.join('\\n'));process.exit(1);}"` exits 0 |
| AC3 | Build succeeds after this card lands | `rtk pnpm build` is green |
| AC4 | Protocol schema tests pass | `rtk pnpm exec vitest run --project @do-soul/alaya-protocol -t "trust state"` |
| AC5 | Daemon recorder tests pass | `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon -t "trust state"` |
| AC6 | Completion report captures source files, port mode, verification, deviations, and deferrals | `docs/v0.1/phase-4-briefs/reports/task-p4-trust-state.md` exists and cites backlog #BL-015 / #BL-020 |
| AC7 | Closing readiness label is `live-event-ready` | `docs/handbook/runtime-status.md` and `docs/v0.1/INDEX.md` are updated only after evidence supports the label |
| AC8 | All 9 behaviors B1-B9 from §2.4 each have at least one matching test | grep test names against the §2.4 table |
| AC9 | The state reduction table §2.5 is exhaustively tested with one test per row | grep test names against the §2.5 table; every row appears |
| AC10 | SQL migration `056-trust-state-persistence.sql` exists and `trust-state-repo.ts` exports a `TrustStateRepo` type, closing the loop with `#BL-022` | `rtk node -e "const fs=require('fs');for(const p of ['packages/storage/src/migrations/056-trust-state-persistence.sql','packages/storage/src/repos/trust-state-repo.ts']){if(!fs.existsSync(p)){process.exit(1)}};"` and `rtk rg -n "export .*TrustStateRepo" packages/storage/src/repos/trust-state-repo.ts` |

## 5. Verification

1. `rtk pnpm install`
2. `rtk pnpm build`
3. `rtk pnpm exec tsc --noEmit -p packages/protocol`
4. `rtk pnpm exec tsc --noEmit -p apps/core-daemon`
5. `rtk pnpm exec vitest run --project @do-soul/alaya-protocol -t "trust state"`
6. `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon -t "trust state"`
7. `rg -n "TrustStateSchema\|ContextDeliveryRecordSchema\|UsageProofRecordSchema" packages/protocol/src/index.ts` — confirms barrel export

## 6. Shared File Hazards & Dependencies

- **Owns** the `packages/protocol/src/index.ts` barrel exception for the new trust schemas. INDEX shared-file table line for `packages/protocol/src/index.ts` is "Owned by P1-protocol; no Phase 2+ card writes it." This card is the explicit, single-shot Phase 4 carve-out. Reviewer must verify no other Phase 4 card writes that file.
- Imports `EventPublisher` from `packages/core/src/event-publisher.ts`
  (P2-svc-event-publisher). The #BL-015 repair changed the mutation
  callback to receive the appended `EventLogEntry`; #BL-021 records this
  as the explicit vendor divergence.
- Imports `SoulContextUsageStateSchema` from `packages/protocol/src/soul/mcp-types.ts` (already exported by P1-protocol).

**Prerequisite**: P4-daemon-startup-ordering.
**Blocks**: P4-mcp-memory-tools, P4-cli-status, Gate-4 demo.
