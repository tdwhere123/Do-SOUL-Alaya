import {
  FactualPolicyConditionSchema,
  IsoDatetimeStringSchema,
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
  const parsed: MemoryEntryUpdateFields = {
    content: fields.content,
    domain_tags: fields.domain_tags,
    evidence_refs: fields.evidence_refs,
    storage_tier: fields.storage_tier,
    last_used_at: fields.last_used_at,
    last_hit_at: fields.last_hit_at
  };

  if (
    parsed.content === undefined &&
    parsed.domain_tags === undefined &&
    parsed.evidence_refs === undefined &&
    parsed.storage_tier === undefined &&
    parsed.last_used_at === undefined &&
    parsed.last_hit_at === undefined
  ) {
    throw new CoreError("VALIDATION", "At least one field is required for update");
  }

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
  const updatedFields: string[] = [];

  if (fields.content !== undefined) {
    updatedFields.push("content");
  }
  if (fields.domain_tags !== undefined) {
    updatedFields.push("domain_tags");
  }
  if (fields.evidence_refs !== undefined) {
    updatedFields.push("evidence_refs");
  }
  if (fields.storage_tier !== undefined) {
    updatedFields.push("storage_tier");
  }
  if (fields.last_used_at !== undefined) {
    updatedFields.push("last_used_at");
  }
  if (fields.last_hit_at !== undefined) {
    updatedFields.push("last_hit_at");
  }

  return updatedFields;
}

export function ensureAllowedLifecycleTransition(
  from: MemoryEntry["lifecycle_state"],
  to: MemoryEntry["lifecycle_state"]
): void {
  if (!isValidLifecycleTransition(from, to)) {
    throw new CoreError("VALIDATION", `Invalid memory lifecycle transition: ${from} -> ${to}`);
  }
}
