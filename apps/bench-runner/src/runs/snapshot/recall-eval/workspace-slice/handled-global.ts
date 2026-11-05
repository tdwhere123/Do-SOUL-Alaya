export interface WorkspaceParentReference {
  readonly parentTable: string;
  readonly parentKey: string;
  readonly childKey: string;
}

export type GlobalTablePolicy =
  | { readonly action: "schema_ledger" }
  | { readonly action: "copy_all" }
  | { readonly action: "copy_none" }
  | {
      readonly action: "copy_via_fk";
      // Exactly one non-null FK selects the row owner; null references do not confer scope.
      readonly references: readonly [WorkspaceParentReference, ...WorkspaceParentReference[]];
    };

// Process leases must not be imported; a packed owner_token is not this pager.
const COPY_NONE = Object.freeze({ action: "copy_none" as const });
const COPY_ALL = Object.freeze({ action: "copy_all" as const });
const SCHEMA_LEDGER = Object.freeze({ action: "schema_ledger" as const });

export const GLOBAL_TABLE_POLICY: Readonly<Record<string, GlobalTablePolicy>> = Object.freeze({
  schema_version: SCHEMA_LEDGER,
  garden_semantic_schema: COPY_ALL,
  garden_embedding_backfill_objects: Object.freeze({
    action: "copy_via_fk" as const,
    references: [{
      parentTable: "garden_embedding_backfill_runs", parentKey: "task_id", childKey: "task_id"
    }] as const
  }),
  app_config: COPY_ALL,
  consolidation_trigger_budgets: COPY_ALL,
  extension_descriptors: COPY_ALL,
  tool_specs: COPY_ALL,
  temporal_projection_generations: COPY_ALL,
  temporal_projection_selection_audit: COPY_ALL,
  temporal_schema_state: COPY_ALL,
  relation_assertion_evidence: Object.freeze({
    action: "copy_via_fk" as const,
    references: [{
      parentTable: "relation_assertions", parentKey: "assertion_id", childKey: "assertion_id"
    }] as const
  }),
  global_memory_entries: COPY_ALL,
  reconciliation_leases: COPY_NONE,
  // Election completion is in EventLog; packed process ownership cannot transfer to a slice.
  claim_election_leases: COPY_NONE,
  proposal_reviewer_assignments: Object.freeze({
    action: "copy_via_fk" as const,
    references: [{
      parentTable: "proposals", parentKey: "proposal_id", childKey: "proposal_id"
    }] as const
  }),
  trust_usage_proof: Object.freeze({
    action: "copy_via_fk" as const,
    references: [{
      parentTable: "trust_context_delivery", parentKey: "delivery_id", childKey: "delivery_id"
    }] as const
  }),
  gap_records: Object.freeze({
    action: "copy_via_fk" as const,
    references: [{
      parentTable: "runs", parentKey: "run_id", childKey: "detected_in_run_id"
    }] as const
  }),
  handoff_records: Object.freeze({
    action: "copy_via_fk" as const,
    references: [{
      parentTable: "runs", parentKey: "run_id", childKey: "source_run_id"
    }] as const
  }),
  tool_execution_records: Object.freeze({
    action: "copy_via_fk" as const,
    references: [
      { parentTable: "runs", parentKey: "run_id", childKey: "requesting_principal_run_id" },
      { parentTable: "worker_runs", parentKey: "worker_run_id", childKey: "requesting_worker_run_id" }
    ] as const
  })
});

export function policyForGlobalTable(name: string): GlobalTablePolicy | undefined {
  return Object.hasOwn(GLOBAL_TABLE_POLICY, name) ? GLOBAL_TABLE_POLICY[name] : undefined;
}
