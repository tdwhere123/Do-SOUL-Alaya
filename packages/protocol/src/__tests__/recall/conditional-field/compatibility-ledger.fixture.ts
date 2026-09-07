export const COMPATIBILITY_DISPOSITIONS = [
  "already-migrated",
  "ignore-on-target",
  "freeze-live",
  "forbidden-second-selector",
  "deferred-D01",
  "unreachable-on-target"
] as const;

export type CompatibilityDisposition = (typeof COMPATIBILITY_DISPOSITIONS)[number];

export type CompatibilityLedgerRow = Readonly<{
  readonly field: string;
  readonly disposition: CompatibilityDisposition;
  readonly note: string;
}>;

export const COMPATIBILITY_LEDGER: readonly CompatibilityLedgerRow[] = Object.freeze([
  Object.freeze({
    field: "query",
    disposition: "already-migrated",
    note: "ordinary-language query already compiles to QueryProgram on the target entry"
  }),
  Object.freeze({
    field: "recent_turn",
    disposition: "ignore-on-target",
    note: "ignored for ordinary Recall; post-turn extract stays on report_context_usage"
  }),
  Object.freeze({
    field: "source_observed_at",
    disposition: "already-migrated",
    note: "maps to interpretation_clock / observed_at on effect ports"
  }),
  Object.freeze({
    field: "since/until/time_field",
    disposition: "already-migrated",
    note: "compiler hints, not global associated-item predicates"
  }),
  Object.freeze({
    field: "max_results",
    disposition: "already-migrated",
    note: "page budget, not tau"
  }),
  Object.freeze({
    field: "delivery_path",
    disposition: "deferred-D01",
    note: "optional public field omitted on the target path; retire or freeze ignored-on-read in D01"
  }),
  Object.freeze({
    field: "ranking_authority",
    disposition: "deferred-D01",
    note: "optional public field omitted on the target path; retire or freeze ignored-on-read in D01"
  }),
  Object.freeze({
    field: "host_context",
    disposition: "freeze-live",
    note: "accepted by MCP; not a conditional-field request field"
  }),
  Object.freeze({
    field: "scope_class/dimension/domain_tags",
    disposition: "freeze-live",
    note: "authorization still applies; not a ranking axis"
  }),
  Object.freeze({
    field: "persisted_old_receipts",
    disposition: "freeze-live",
    note: "admitted evidence history keeps live meaning; no mixed-schema reinterpretation"
  }),
  Object.freeze({
    field: "rebuildable_projections",
    disposition: "already-migrated",
    note: "source/relation/embedding projections may refresh; they are not admitted evidence"
  }),
  Object.freeze({
    field: "operational_feedback",
    disposition: "unreachable-on-target",
    note: "usage/watermark/scheduler records are not semantic truth and must not mutate PathRelation.strength"
  }),
  Object.freeze({
    field: "continuation",
    disposition: "already-migrated",
    note: "query_id/snapshot_id/result_version remain; interpretation_id is additive"
  }),
  Object.freeze({
    field: "second_production_selector",
    disposition: "forbidden-second-selector",
    note: "select_gamma/prefix_sk must not become a parallel production selector"
  })
]);
