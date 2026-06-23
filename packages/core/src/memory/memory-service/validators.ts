import {
  FactualPolicyConditionSchema,
  IsoDatetimeStringSchema,
  MemoryEntryMutableFieldsSchema,
  MemoryEntrySchema,
  ObjectLifecycleStateSchema,
  StorageTierSchema,
  TransitionCausedBySchema,
  isValidLifecycleTransition,
  type FactualPolicyCondition,
  type MemoryEntry,
  type TransitionCausedBy
} from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
import type { MemoryEntryUpdateFields } from "./types.js";

export { isPromiseLike } from "../../shared/promise-utils.js";

const MEMORY_UPDATE_FIELD_NAMES = [
  "content",
  "domain_tags",
  "evidence_refs",
  "storage_tier",
  "last_used_at",
  "last_hit_at",
  "projection_schema_version",
  "event_time_start",
  "event_time_end",
  "valid_from",
  "valid_to",
  "time_precision",
  "time_source",
  "preference_subject",
  "preference_predicate",
  "preference_object",
  "preference_category",
  "preference_polarity"
] as const satisfies readonly (keyof MemoryEntryUpdateFields)[];

export function parseMemoryEntry(value: MemoryEntry): MemoryEntry {
  try {
    return MemoryEntrySchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid memory entry payload", { cause: error });
  }
}

export function parseFactualPolicyCondition(condition: FactualPolicyCondition): FactualPolicyCondition {
  try {
    return FactualPolicyConditionSchema.parse(condition);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid factual policy condition", { cause: error });
  }
}

export function parseStorageTier(value: MemoryEntry["storage_tier"]): MemoryEntry["storage_tier"] {
  try {
    return StorageTierSchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid storage tier", { cause: error });
  }
}

export function parseLifecycleState(value: MemoryEntry["lifecycle_state"]): MemoryEntry["lifecycle_state"] {
  try {
    return ObjectLifecycleStateSchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid lifecycle state", { cause: error });
  }
}

export function parseReason(value: string): string {
  if (value.trim().length === 0) {
    throw new CoreError("VALIDATION", "Reason is required");
  }

  return value;
}

export function isRepoGuardRefusal(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const code = (error as { readonly code?: unknown }).code;
  return code === "NOT_FOUND" || code === "VALIDATION_FAILED";
}

export function parseTransitionCausedBy(value: TransitionCausedBy): TransitionCausedBy {
  try {
    return TransitionCausedBySchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid transition caused_by", { cause: error });
  }
}

export function parseUpdateFields(fields: MemoryEntryUpdateFields): MemoryEntryUpdateFields {
  const parsed = parseMutableUpdateFields(fields);
  assertHasUpdateField(parsed);

  if (parsed.content !== undefined && parsed.content.trim().length === 0) {
    throw new CoreError("VALIDATION", "Memory content cannot be empty");
  }

  if (parsed.domain_tags !== undefined) {
    assertStringArray(parsed.domain_tags, "domain_tags");
  }

  if (parsed.evidence_refs !== undefined) {
    assertStringArray(parsed.evidence_refs, "evidence_refs");
  }

  const parsedStorageTier =
    parsed.storage_tier === undefined ? undefined : parseStorageTier(parsed.storage_tier);
  const parsedLastUsedAt =
    parsed.last_used_at === undefined ? undefined : parseIsoDatetime(parsed.last_used_at);
  const parsedLastHitAt =
    parsed.last_hit_at === undefined ? undefined : parseIsoDatetime(parsed.last_hit_at);

  return {
    ...parsed,
    storage_tier: parsedStorageTier,
    last_used_at: parsedLastUsedAt,
    last_hit_at: parsedLastHitAt
  };
}

function parseMutableUpdateFields(fields: MemoryEntryUpdateFields): MemoryEntryUpdateFields {
  try {
    const { last_used_at, last_hit_at, ...mutableFields } = fields;
    const parsedMutable = MemoryEntryMutableFieldsSchema.parse(mutableFields);
    return { ...parsedMutable, last_used_at, last_hit_at };
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid memory update fields", { cause: error });
  }
}

function assertHasUpdateField(fields: MemoryEntryUpdateFields): void {
  if (MEMORY_UPDATE_FIELD_NAMES.some((fieldName) => fields[fieldName] !== undefined)) {
    return;
  }

  throw new CoreError("VALIDATION", "At least one field is required for update");
}

export function shouldRevokeGreenForEvidenceRewrite(
  previousEvidenceRefs: readonly string[],
  nextEvidenceRefs: readonly string[]
): boolean {
  if (previousEvidenceRefs.length === 0) {
    return false;
  }
  const next = new Set(nextEvidenceRefs);
  return !previousEvidenceRefs.some((ref) => next.has(ref));
}

export function parseIsoDatetime(value: string): string {
  try {
    return IsoDatetimeStringSchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid timestamp", { cause: error });
  }
}

export function assertStringArray(value: readonly string[], field: "domain_tags" | "evidence_refs"): void {
  for (const item of value) {
    if (item.trim().length === 0) {
      throw new CoreError("VALIDATION", `${field} cannot contain empty items`);
    }
  }
}

export function toUpdatedFieldNames(fields: MemoryEntryUpdateFields): string[] {
  return MEMORY_UPDATE_FIELD_NAMES.filter((fieldName) => fields[fieldName] !== undefined);
}

export function ensureAllowedLifecycleTransition(
  from: MemoryEntry["lifecycle_state"],
  to: MemoryEntry["lifecycle_state"]
): void {
  if (!isValidLifecycleTransition(from, to)) {
    throw new CoreError("VALIDATION", `Invalid memory lifecycle transition: ${from} -> ${to}`);
  }
}
