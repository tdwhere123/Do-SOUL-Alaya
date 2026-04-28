import type { MemoryEntry, ScopeClass } from "../ontology/types.js";
import type { PathAnchorRef } from "../structure/types.js";
import type {
  RecallCandidate,
  RecallExclusion,
  RecallGovernanceState,
  RecallMemoryRecord,
  RecallQuery,
  RecallRoute,
  RecallRouteContribution,
  RecallSourcePlane
} from "./types.js";

export function clampUnit(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

export function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US");
}

export function countCodepoints(value: string): number {
  return Array.from(value).length;
}

export function tokenizeSearchText(value: string): readonly string[] {
  const normalized = normalizeSearchText(value);
  const matches = normalized.match(/[\p{L}\p{N}_]+/gu);
  if (matches === null) {
    return Object.freeze([]);
  }
  return Object.freeze(Array.from(new Set(matches.map((entry) => entry.trim()).filter((entry) => entry.length > 0))));
}

export function compareCandidates(left: RecallCandidate, right: RecallCandidate): number {
  const scoreDelta = right.recall_score - left.recall_score;
  if (scoreDelta !== 0) {
    return scoreDelta;
  }
  return left.object_id.localeCompare(right.object_id);
}

export function compareObjectIds(left: { readonly object_id: string }, right: { readonly object_id: string }): number {
  return left.object_id.localeCompare(right.object_id);
}

export function normalizeLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit <= 0) {
    return 0;
  }
  return limit;
}

export function getGovernanceState(record: RecallMemoryRecord): RecallGovernanceState {
  return record.governance_state ?? "visible";
}

export function evaluateRecordEligibility(
  record: RecallMemoryRecord,
  query: RecallQuery | null,
  route: RecallRoute
): { readonly eligible: true } | { readonly eligible: false; readonly exclusion: RecallExclusion } {
  const memory = record.memory;
  const governanceState = getGovernanceState(record);

  if (query !== null && memory.workspace_id !== query.workspace_id) {
    return {
      eligible: false,
      exclusion: buildExclusion(record, route, "workspace_mismatch", false)
    };
  }

  if (memory.lifecycle_state !== "active") {
    return {
      eligible: false,
      exclusion: buildExclusion(record, route, "lifecycle_not_active", false)
    };
  }

  if (memory.retention_state === "tombstoned") {
    return {
      eligible: false,
      exclusion: buildExclusion(record, route, "tombstoned", false)
    };
  }

  if (query !== null && query.scope_classes !== undefined && !query.scope_classes.includes(memory.scope_class)) {
    return {
      eligible: false,
      exclusion: buildExclusion(record, route, "scope_mismatch", false)
    };
  }

  if (
    query !== null &&
    query.domain_tags !== undefined &&
    query.domain_tags.length > 0 &&
    !hasDomainTag(memory, query.domain_tags)
  ) {
    return {
      eligible: false,
      exclusion: buildExclusion(record, route, "domain_tag_mismatch", true)
    };
  }

  if (governanceState !== "visible") {
    return {
      eligible: false,
      exclusion: buildExclusion(record, route, `governance_${governanceState}`, false)
    };
  }

  return { eligible: true };
}

export function buildExclusion(
  record: RecallMemoryRecord,
  route: RecallRoute,
  reason: string,
  retryable: boolean
): RecallExclusion {
  return {
    object_id: record.memory.object_id,
    route,
    reason,
    scope_class: record.memory.scope_class,
    governance_state: getGovernanceState(record),
    retryable,
    source_plane: route === "path" ? "structure_registry" : route === "embedding" ? "runtime_projection" : "ontology"
  };
}

export function buildStructuredContribution(memory: MemoryEntry): RecallRouteContribution {
  const activation = memory.activation_score === null ? 0 : clampUnit(memory.activation_score);
  const retention = memory.retention_score === null ? 0 : clampUnit(memory.retention_score);
  const confidence = memory.confidence === null ? 0 : clampUnit(memory.confidence);
  return {
    route: "structured",
    source_plane: "ontology",
    score: roundScore(activation * 0.2 + retention * 0.1 + confidence * 0.1),
    reason: "workspace_scope_governance_retention_passed"
  };
}

export function createCandidate(params: {
  readonly memory: MemoryEntry;
  readonly contributions: readonly RecallRouteContribution[];
  readonly inclusionReason: string;
}): RecallCandidate {
  const score = params.contributions.reduce((sum, contribution) => sum + contribution.score, 0);
  return {
    object_id: params.memory.object_id,
    memory: params.memory,
    recall_score: roundScore(score),
    source_plane: "ontology",
    inclusion_reason: params.inclusionReason,
    contributions: Object.freeze([...params.contributions])
  };
}

export function recordMap(records: readonly RecallMemoryRecord[]): ReadonlyMap<string, RecallMemoryRecord> {
  return new Map(records.map((record) => [record.memory.object_id, record] as const));
}

export function listAnchorObjectRefs(anchor: PathAnchorRef): readonly string[] {
  switch (anchor.kind) {
    case "object":
      return [anchor.object_id];
    case "object_facet":
      return [anchor.object_id];
    case "obligation":
      return [anchor.source_object_id];
    case "risk_concern":
      return [anchor.source_object_id];
    case "time_concern":
      return [anchor.source_object_id];
  }
}

export function roundScore(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function uniqueSourcePlanes(candidates: readonly RecallCandidate[], degraded: boolean): readonly RecallSourcePlane[] {
  const present = new Set<RecallSourcePlane>();
  for (const candidate of candidates) {
    present.add(candidate.source_plane);
    for (const contribution of candidate.contributions) {
      present.add(contribution.source_plane);
    }
  }
  present.add("runtime_projection");
  if (degraded) {
    present.add("degradation");
  }

  const order: readonly RecallSourcePlane[] = ["ontology", "structure_registry", "runtime_projection", "degradation"];
  return Object.freeze(order.filter((plane) => present.has(plane)));
}

function hasDomainTag(memory: MemoryEntry, tags: readonly string[]): boolean {
  const normalizedTags = new Set(memory.domain_tags.map((tag) => normalizeSearchText(tag)));
  return tags.some((tag) => normalizedTags.has(normalizeSearchText(tag)));
}

export function scopeClassForMemory(memory: MemoryEntry): ScopeClass {
  return memory.scope_class;
}
