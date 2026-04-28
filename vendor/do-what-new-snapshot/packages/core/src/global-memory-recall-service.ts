import {
  FormationKind,
  type GlobalMemoryEntry,
  ObjectLifecycleState,
  SourceKind,
  StorageTier,
  type MemoryEntry,
  type ProjectMappingAnchor,
  type ProjectMappingState,
  type ScopeClass
} from "@do-what/protocol";
import type {
  GlobalMemoryRecallEntry,
  GlobalMemoryRecallPort
} from "./global-memory-recall-port.js";

export interface GlobalMemoryRecallProjectMappingPort {
  findByWorkspace(workspaceId: string): Promise<readonly Readonly<ProjectMappingAnchor>[]>;
  ensureSuggestedAnchors?(
    globalObjectIds: readonly string[],
    workspaceId: string,
    createdBy: string
  ): Promise<readonly Readonly<ProjectMappingAnchor>[]>;
}

export interface GlobalMemoryRecallCandidate {
  readonly entry: Readonly<MemoryEntry>;
  readonly originPlane: "global";
  readonly isAdvisory: false;
}

export interface GlobalMemoryRecallSourcePort {
  list(): Promise<readonly Readonly<GlobalMemoryEntry>[]>;
}

export interface GlobalMemoryRecallRecord {
  readonly globalObjectId: string;
  readonly candidate: Readonly<GlobalMemoryRecallCandidate> | null;
}

type GlobalCandidateClassification = Readonly<{
  include: boolean;
  reason: "adopted" | "no_anchor" | `not_adopted:${ProjectMappingState}`;
  anchor_state: ProjectMappingState | null;
}>;

export async function loadGlobalRecallCandidates(params: {
  readonly workspaceId: string;
  readonly queryText: string | null;
  readonly limit: number;
  readonly createdBy?: string;
  readonly globalRecallPort?: GlobalMemoryRecallPort;
  readonly projectMappingPort?: GlobalMemoryRecallProjectMappingPort;
  readonly classifyGlobalCandidate: (
    entry: { readonly global_object_id: string },
    anchorMap: ReadonlyMap<string, Readonly<ProjectMappingAnchor>>
  ) => GlobalCandidateClassification;
}): Promise<{
  readonly total_scanned: number;
  readonly candidates: readonly Readonly<GlobalMemoryRecallCandidate>[];
  readonly records: readonly Readonly<GlobalMemoryRecallRecord>[];
}> {
  if (params.globalRecallPort === undefined) {
    return Object.freeze({
      total_scanned: 0,
      candidates: Object.freeze([]),
      records: Object.freeze([])
    });
  }

  const surfacedEntries = await params.globalRecallPort.recall({
    workspaceId: params.workspaceId,
    queryText: params.queryText,
    limit: params.limit
  });

  if (surfacedEntries.length === 0) {
    return Object.freeze({
      total_scanned: 0,
      candidates: Object.freeze([]),
      records: Object.freeze([])
    });
  }

  const orderedGlobalObjectIds = uniqueGlobalObjectIds(surfacedEntries);
  const anchorMap = await loadAnchorMap({
    globalObjectIds: orderedGlobalObjectIds,
    workspaceId: params.workspaceId,
    createdBy: params.createdBy ?? "system",
    projectMappingPort: params.projectMappingPort
  });
  const candidates: GlobalMemoryRecallCandidate[] = [];
  const records = surfacedEntries.map((entry) => {
    const classification = params.classifyGlobalCandidate(entry, anchorMap);
    let candidate: Readonly<GlobalMemoryRecallCandidate> | null = null;

    if (classification.include) {
      candidate = Object.freeze({
        entry: createPseudoMemoryEntry(entry, params.workspaceId),
        originPlane: "global" as const,
        isAdvisory: false
      });
      candidates.push(candidate);
    }

    return Object.freeze({
      globalObjectId: entry.global_object_id,
      candidate
    });
  });

  return Object.freeze({
    total_scanned: surfacedEntries.length,
    candidates: Object.freeze(candidates),
    records: Object.freeze(records)
  });
}

export function createGlobalMemoryRecallPort(params: {
  readonly globalMemorySource: GlobalMemoryRecallSourcePort;
}): GlobalMemoryRecallPort {
  return {
    recall: async ({ queryText, limit }) => {
      const normalizedQuery = normalizeGlobalMemoryQuery(queryText);
      const entries = await params.globalMemorySource.list();
      const matchedEntries =
        normalizedQuery === null
          ? entries
          : entries.filter((entry) => matchesGlobalMemoryQuery(entry, normalizedQuery));
      const sortedEntries = [...matchedEntries].sort(compareGlobalMemoryRecallEntries);

      return sortedEntries.slice(0, limit).map((entry) =>
        Object.freeze({
          global_object_id: entry.global_object_id,
          dimension: entry.dimension,
          scope_class: entry.scope_class,
          content: entry.content,
          domain_tags: entry.domain_tags,
          activation_score: entry.activation_score,
          created_at: entry.created_at,
          updated_at: entry.updated_at
        })
      );
    }
  };
}

async function loadAnchorMap(params: {
  readonly globalObjectIds: readonly string[];
  readonly workspaceId: string;
  readonly createdBy: string;
  readonly projectMappingPort?: GlobalMemoryRecallProjectMappingPort;
}): Promise<ReadonlyMap<string, Readonly<ProjectMappingAnchor>>> {
  if (params.projectMappingPort === undefined) {
    return new Map();
  }

  if (params.projectMappingPort.ensureSuggestedAnchors !== undefined) {
    return new Map(
      (
        await params.projectMappingPort.ensureSuggestedAnchors(
          params.globalObjectIds,
          params.workspaceId,
          params.createdBy
        )
      ).map((anchor) => [anchor.global_object_id, anchor] as const)
    );
  }

  const globalObjectIdSet = new Set(params.globalObjectIds);

  return new Map(
    (await params.projectMappingPort.findByWorkspace(params.workspaceId))
      .filter((anchor) => globalObjectIdSet.has(anchor.global_object_id))
      .map((anchor) => [anchor.global_object_id, anchor] as const)
  );
}

function uniqueGlobalObjectIds(
  entries: readonly Readonly<GlobalMemoryRecallEntry>[]
): readonly string[] {
  return Object.freeze([...new Set(entries.map((entry) => entry.global_object_id))]);
}

function normalizeGlobalMemoryQuery(queryText: string | null): readonly string[] | null {
  if (queryText === null) {
    return null;
  }

  const tokens = queryText
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0);

  return tokens.length === 0 ? null : tokens;
}

function matchesGlobalMemoryQuery(
  entry: Readonly<GlobalMemoryEntry>,
  queryTokens: readonly string[]
): boolean {
  const haystack = [
    entry.canonical_identity,
    entry.content,
    entry.provenance,
    ...entry.domain_tags
  ]
    .join(" ")
    .toLowerCase();

  return queryTokens.every((token) => haystack.includes(token));
}

function compareGlobalMemoryRecallEntries(
  left: Readonly<GlobalMemoryEntry>,
  right: Readonly<GlobalMemoryEntry>
): number {
  const leftScore = left.activation_score ?? -1;
  const rightScore = right.activation_score ?? -1;

  if (leftScore !== rightScore) {
    return rightScore - leftScore;
  }

  if (left.updated_at !== right.updated_at) {
    return right.updated_at.localeCompare(left.updated_at);
  }

  if (left.created_at !== right.created_at) {
    return right.created_at.localeCompare(left.created_at);
  }

  return left.global_object_id.localeCompare(right.global_object_id);
}

function createPseudoMemoryEntry(
  entry: Readonly<GlobalMemoryRecallEntry>,
  workspaceId: string
): Readonly<MemoryEntry> {
  const pseudoRunId = `global:${entry.global_object_id}`;

  return Object.freeze({
    object_id: entry.global_object_id,
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: ObjectLifecycleState.ACTIVE,
    created_at: entry.created_at,
    updated_at: entry.updated_at,
    created_by: "system",
    dimension: entry.dimension,
    source_kind: SourceKind.IMPORT,
    formation_kind: FormationKind.IMPORTED,
    scope_class: entry.scope_class as ScopeClass,
    content: entry.content,
    domain_tags: Object.freeze([...(entry.domain_tags ?? [])]),
    evidence_refs: Object.freeze([...(entry.evidence_refs ?? [])]),
    workspace_id: workspaceId,
    run_id: pseudoRunId,
    surface_id: null,
    storage_tier: StorageTier.HOT,
    activation_score: entry.activation_score ?? null,
    retention_score: null,
    manifestation_state: null,
    retention_state: null,
    decay_profile: null,
    confidence: null,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: null,
    contradiction_count: null,
    superseded_by: null
  });
}
