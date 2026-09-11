export type EngineCostField = Readonly<{
  readonly solver_completed_work?: number;
  readonly seen_identities: { readonly length: number };
  readonly remaining_memory_bytes: number;
  readonly remaining_work: readonly { readonly units: number }[];
  readonly pending_path_effects?: { readonly retained_bytes?: number };
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
    remaining_memory_bytes: Math.max(0, memoryBytes - (field.pending_path_effects?.retained_bytes ?? 0))
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
    charged_retained_bytes: Math.max(0, before.remaining_memory_bytes - after.remaining_memory_bytes),
    // Remaining worklist after observe; not units executed this request.
    pending_work: field.remaining_work.reduce((sum, row) => sum + row.units, 0)
  };
}

export function retainedFieldLevels(field: EngineCostField, memoryBytes: number): RetainedFieldLevels {
  return {
    retained_states_current: field.seen_identities.length,
    retained_bytes_current: Math.max(0, memoryBytes - field.remaining_memory_bytes)
  };
}
