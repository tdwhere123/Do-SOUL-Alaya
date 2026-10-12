export type EngineCostField = Readonly<{
  readonly solver_completed_work?: number;
  readonly solver_retained_bytes?: number;
  readonly support_retained_bytes?: number;
  readonly seen_identities: { readonly length: number };
  readonly remaining_memory_bytes: number;
  readonly remaining_work: readonly { readonly units: number }[];
  readonly pending_path_effects?: { readonly retained_bytes?: number;
    readonly preparation?: { readonly retained_bytes: number } };
  readonly binding_contexts?: { readonly bytes: number };
  readonly binding_context_bytes?: number;
  readonly pair_demand_bytes?: number;
  readonly pair_progress_bytes?: number;
  readonly source_fact_demand_bytes?: number;
  readonly source_fact_bytes?: number;
  readonly observed_relation_bytes?: number;
  readonly compiled_automaton_bytes?: number;
  readonly sequence_reach_bytes?: number;
  readonly grounding_progress?: { readonly retained_bytes: number };
  readonly explanation_progress?: { readonly retainedBytes: number };
  readonly admitted_allocation_bytes: number;
  readonly accounted_retained_bytes?: number;
}>;

export type EngineWorkMeters = Readonly<{
  readonly solver_completed_work: number;
  readonly charged_identities: number;
  readonly remaining_memory_bytes: number;
}>;

export type EngineWorkDelta = Readonly<{
  readonly relaxations: number;
  readonly state_creates: number;
  readonly charged_retained_bytes: number;
  readonly pending_work: number;
}>;

export type RetainedFieldLevels = Readonly<{
  readonly retained_states_current: number;
  readonly retained_bytes_current: number;
}>;

/** One owner for the retained field footprint; the phase stamp also covers delivery progress and payload debits. */
export function restoredFieldFootprint(field: EngineCostField): number {
  const owners = (field.pending_path_effects?.retained_bytes ?? 0)
    + (field.pending_path_effects?.preparation?.retained_bytes ?? 0)
    + (field.binding_context_bytes ?? field.binding_contexts?.bytes ?? 0)
    + (field.solver_retained_bytes ?? 0) + (field.support_retained_bytes ?? 0)
    + (field.pair_demand_bytes ?? 0) + (field.pair_progress_bytes ?? 0)
    + (field.source_fact_demand_bytes ?? 0) + (field.source_fact_bytes ?? 0)
    + (field.observed_relation_bytes ?? 0) + (field.compiled_automaton_bytes ?? 0)
    + (field.sequence_reach_bytes ?? 0)
    + (field.grounding_progress?.retained_bytes ?? 0) + (field.explanation_progress?.retainedBytes ?? 0);
  return Math.max(owners, field.accounted_retained_bytes ?? 0);
}

/** Available allowance saturates at zero; retained allocations do not. */
export function restoredFieldRemainingMemory(field: EngineCostField, memoryBytes: number): number {
  return Math.max(0, memoryBytes - restoredFieldFootprint(field));
}

export function stampRetainedFieldLevel<T extends EngineCostField>(field: T, memoryBytes: number): T {
  return { ...field, accounted_retained_bytes: Math.max(0, memoryBytes - field.remaining_memory_bytes) };
}

export function snapshotRestoredEngineWork(
  field: EngineCostField | undefined,
  memoryBytes: number
): EngineWorkMeters {
  if (field === undefined) {
    return { solver_completed_work: 0, charged_identities: 0, remaining_memory_bytes: memoryBytes };
  }
  // Resume resets remaining_memory_bytes from this request's budget; leftover remaining is not the before meter.
  return {
    solver_completed_work: field.solver_completed_work ?? 0,
    charged_identities: field.seen_identities.length,
    remaining_memory_bytes: restoredFieldRemainingMemory(field, memoryBytes)
  };
}

export function snapshotObservedEngineWork(field: EngineCostField): EngineWorkMeters {
  return {
    solver_completed_work: field.solver_completed_work ?? 0,
    charged_identities: field.seen_identities.length,
    remaining_memory_bytes: field.remaining_memory_bytes
  };
}

export function thisRequestObservedWork(
  restored: EngineCostField | undefined,
  field: EngineCostField,
  memoryBytes: number
): EngineWorkDelta {
  const before = snapshotRestoredEngineWork(restored, memoryBytes);
  const after = snapshotObservedEngineWork(field);
  return {
    relaxations: Math.max(0, after.solver_completed_work - before.solver_completed_work),
    state_creates: Math.max(0, after.charged_identities - before.charged_identities),
    charged_retained_bytes: Math.max(0, field.admitted_allocation_bytes - (restored?.admitted_allocation_bytes ?? 0)),
    // Remaining worklist after observe; not units executed this request.
    pending_work: field.remaining_work.reduce((sum, row) => sum + row.units, 0)
  };
}

export function retainedFieldLevels(field: EngineCostField, memoryBytes: number): RetainedFieldLevels {
  return {
    retained_states_current: field.seen_identities.length,
    retained_bytes_current: Math.max(restoredFieldFootprint(field),
      Math.max(0, memoryBytes - field.remaining_memory_bytes))
  };
}
