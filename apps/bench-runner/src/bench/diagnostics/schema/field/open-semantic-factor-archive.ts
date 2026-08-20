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

const OPEN_SEMANTIC_FACTOR_COMPATIBILITY_RECEIPT = {
  schemaVersion: 1,
  operatorId: "open_semantic_factor_compatibility_v6"
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
  if (record.schema_version !== expected.schemaVersion ||
      record.operator_id !== expected.operatorId) {
    return true;
  }
  return wireKey === "open_semantic_factor_compatibility_trace" &&
    hasNestedStaleCompatibilityReceipt(record);
}

function hasNestedStaleCompatibilityReceipt(
  trace: Readonly<Record<string, unknown>>
): boolean {
  const entries = trace.entries;
  if (!Array.isArray(entries)) return false;
  return entries.some((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
    const receipt = (entry as Readonly<Record<string, unknown>>).receipt;
    if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)) {
      return false;
    }
    const record = receipt as Readonly<Record<string, unknown>>;
    return record.schema_version !== OPEN_SEMANTIC_FACTOR_COMPATIBILITY_RECEIPT.schemaVersion ||
      record.operator_id !== OPEN_SEMANTIC_FACTOR_COMPATIBILITY_RECEIPT.operatorId;
  });
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
