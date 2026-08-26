export type GlobalTablePolicy =
  | { readonly action: "schema_ledger" }
  | { readonly action: "copy_all" }
  | { readonly action: "copy_none" }
  | {
      readonly action: "copy_via_fk";
      readonly parentTable: string;
      readonly parentKey: string;
      readonly childKey: string;
    };

// Process leases must not be imported; a packed owner_token is not this pager.
const COPY_NONE = Object.freeze({ action: "copy_none" as const });
const COPY_ALL = Object.freeze({ action: "copy_all" as const });
const SCHEMA_LEDGER = Object.freeze({ action: "schema_ledger" as const });

export const GLOBAL_TABLE_POLICY: Readonly<Record<string, GlobalTablePolicy>> = Object.freeze({
  schema_version: SCHEMA_LEDGER,
  app_config: COPY_ALL,
  consolidation_trigger_budgets: COPY_ALL,
  extension_descriptors: COPY_ALL,
  tool_specs: COPY_ALL,
  temporal_projection_generations: COPY_ALL,
  temporal_projection_selection_audit: COPY_ALL,
  temporal_schema_state: COPY_ALL,
  // invariant: history operator is corpus-wide; workspace_id is membership.
  relation_assertions: COPY_ALL,
  relation_assertion_resolution_current: COPY_ALL,
  relation_assertion_quarantine: COPY_ALL,
  relation_path_projections: COPY_ALL,
  global_memory_entries: COPY_ALL,
  reconciliation_leases: COPY_NONE,
  proposal_reviewer_assignments: Object.freeze({
    action: "copy_via_fk" as const,
    parentTable: "proposals",
    parentKey: "proposal_id",
    childKey: "proposal_id"
  }),
  relation_assertion_evidence: Object.freeze({
    action: "copy_via_fk" as const,
    parentTable: "relation_assertions",
    parentKey: "assertion_id",
    childKey: "assertion_id"
  }),
  trust_usage_proof: Object.freeze({
    action: "copy_via_fk" as const,
    parentTable: "trust_context_delivery",
    parentKey: "delivery_id",
    childKey: "delivery_id"
  }),
  gap_records: Object.freeze({
    action: "copy_via_fk" as const,
    parentTable: "runs",
    parentKey: "run_id",
    childKey: "detected_in_run_id"
  }),
  handoff_records: Object.freeze({
    action: "copy_via_fk" as const,
    parentTable: "runs",
    parentKey: "run_id",
    childKey: "source_run_id"
  }),
  tool_execution_records: Object.freeze({
    action: "copy_via_fk" as const,
    parentTable: "runs",
    parentKey: "run_id",
    childKey: "requesting_principal_run_id"
  })
});

export function policyForGlobalTable(name: string): GlobalTablePolicy | undefined {
  return GLOBAL_TABLE_POLICY[name];
}
