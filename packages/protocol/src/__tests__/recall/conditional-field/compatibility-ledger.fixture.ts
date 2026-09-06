export const COMPATIBILITY_DISPOSITIONS = [
  "freeze-live",
  "migrate-at-C07",
  "ignore-on-target",
  "forbidden-second-selector"
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
    disposition: "migrate-at-C07",
    note: "ordinary-language query becomes QueryProgram at C07"
  }),
  Object.freeze({
    field: "recent_turn",
    disposition: "ignore-on-target",
    note: "ignored for extraction; ordinary recall does not enqueue"
  }),
  Object.freeze({
    field: "source_observed_at",
    disposition: "migrate-at-C07",
    note: "maps to interpretation_clock"
  }),
  Object.freeze({
    field: "since/until/time_field",
    disposition: "migrate-at-C07",
    note: "compiler hints, not global associated-item predicates"
  }),
  Object.freeze({
    field: "max_results",
    disposition: "migrate-at-C07",
    note: "page budget, not tau"
  }),
  Object.freeze({
    field: "delivery_path",
    disposition: "ignore-on-target",
    note: "ignored on the target path"
  }),
  Object.freeze({
    field: "ranking_authority",
    disposition: "ignore-on-target",
    note: "ignored on the target path"
  }),
  Object.freeze({
    field: "host_context",
    disposition: "freeze-live",
    note: "live soul.recall host_context stays unchanged until C07"
  }),
  Object.freeze({
    field: "scope_class/dimension/domain_tags",
    disposition: "freeze-live",
    note: "authorization still applies; not a ranking axis"
  }),
  Object.freeze({
    field: "persisted_old_receipts",
    disposition: "freeze-live",
    note: "old receipts keep live meaning; no mixed-schema reinterpretation"
  }),
  Object.freeze({
    field: "second_production_selector",
    disposition: "forbidden-second-selector",
    note: "select_gamma/prefix_sk must not become a parallel production selector"
  })
]);
