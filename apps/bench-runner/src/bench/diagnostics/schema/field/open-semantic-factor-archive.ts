export const OPEN_SEMANTIC_FACTOR_ARCHIVE_REASON = "stale_schema" as const;

export type OpenSemanticFactorArchive = Readonly<{
  readonly replayable: false;
  readonly reason: typeof OPEN_SEMANTIC_FACTOR_ARCHIVE_REASON;
}>;

export const OPEN_SEMANTIC_FACTOR_CURRENT_OPERATORS = {
  open_semantic_factor_compatibility_trace: {
    schemaVersion: 2,
    operatorId: "open_semantic_factor_compatibility_trace_v2"
  },
  open_semantic_factor_composition: {
    schemaVersion: 2,
    operatorId: "open_semantic_factor_composition_v2"
  },
  open_semantic_factor_activation: {
    schemaVersion: 2,
    operatorId: "open_semantic_solution_membership_activation_v2"
  }
} as const;

export type OpenSemanticFactorCutoverWireKey =
  keyof typeof OPEN_SEMANTIC_FACTOR_CURRENT_OPERATORS;

export function isStaleOpenSemanticFactorField(
  value: unknown,
  wireKey: OpenSemanticFactorCutoverWireKey
): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const expected = OPEN_SEMANTIC_FACTOR_CURRENT_OPERATORS[wireKey];
  const record = value as Readonly<Record<string, unknown>>;
  return record.schema_version !== expected.schemaVersion ||
    record.operator_id !== expected.operatorId;
}

export function openSemanticFactorArchiveMarker(): OpenSemanticFactorArchive {
  return Object.freeze({
    replayable: false as const,
    reason: OPEN_SEMANTIC_FACTOR_ARCHIVE_REASON
  });
}

export function archiveStaleOpenSemanticFactorFields(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const next: Record<string, unknown> = { ...record };
  let stale = false;
  for (const wireKey of Object.keys(OPEN_SEMANTIC_FACTOR_CURRENT_OPERATORS) as
    OpenSemanticFactorCutoverWireKey[]) {
    if (next[wireKey] == null) continue;
    if (!isStaleOpenSemanticFactorField(next[wireKey], wireKey)) continue;
    stale = true;
    delete next[wireKey];
  }
  if (stale) next.open_semantic_factor_archive = openSemanticFactorArchiveMarker();
  return next;
}
