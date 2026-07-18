import {
  type EventLogEntry,
  FormationKind,
  type GlobalMemoryEntry,
  ObjectLifecycleState,
  ScopeClassSchema,
  SourceKind,
  StorageTier,
  type MemoryEntry,
  type ProjectMappingAnchor,
  type ProjectMappingState
} from "@do-soul/alaya-protocol";
import type { GlobalMemoryRecallEntry, GlobalMemoryRecallPort } from "./global-memory-recall-port.js";
import type { RecallTimeFilter } from "./recall-service-helpers.js";
import { selectGlobalMemoryRecallEntries } from "./global-memory/selection.js";

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
  listAll?(): Promise<readonly Readonly<GlobalMemoryEntry>[]>;
  listPage?(page: GlobalMemoryRecallSourcePageOptions): Promise<readonly Readonly<GlobalMemoryEntry>[]>;
}

export interface GlobalMemoryRecallSourcePageOptions {
  readonly limit: number;
  readonly offset: number;
}

export interface GlobalMemoryRecallRecord {
  readonly globalObjectId: string;
  readonly candidate: Readonly<GlobalMemoryRecallCandidate> | null;
}

export interface GlobalMemoryRecallSubscription {
  dispose(): void;
}

export interface GlobalMemoryRecallInvalidationNotifier {
  subscribeEntries(
    listener: (entry: Readonly<EventLogEntry>) => void | Promise<void>
  ): GlobalMemoryRecallSubscription;
}

export interface GlobalMemoryRecallServicePort extends GlobalMemoryRecallPort {
  subscribeToInvalidations(
    notifier: GlobalMemoryRecallInvalidationNotifier
  ): GlobalMemoryRecallSubscription;
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
  readonly timeFilter?: RecallTimeFilter;
  readonly entryMatchesTimeFilter?: (
    entry: Readonly<MemoryEntry>,
    filter: RecallTimeFilter | undefined
  ) => boolean;
}): Promise<{
  readonly total_scanned: number;
  readonly candidates: readonly Readonly<GlobalMemoryRecallCandidate>[];
  readonly records: readonly Readonly<GlobalMemoryRecallRecord>[];
}> {
  if (params.globalRecallPort === undefined) {
    return emptyGlobalRecallCandidatesResult();
  }
  const surfacedEntries = await params.globalRecallPort.recall({
    workspaceId: params.workspaceId,
    queryText: params.queryText,
    limit: params.limit
  });
  if (surfacedEntries.length === 0) {
    return emptyGlobalRecallCandidatesResult();
  }
  const orderedGlobalObjectIds = uniqueGlobalObjectIds(surfacedEntries);
  const anchorMap = await loadAnchorMap({
    globalObjectIds: orderedGlobalObjectIds,
    workspaceId: params.workspaceId,
    createdBy: params.createdBy ?? "system",
    projectMappingPort: params.projectMappingPort
  });
  const selection = buildGlobalRecallSelection(params, surfacedEntries, anchorMap);
  return Object.freeze({
    total_scanned: surfacedEntries.length,
    candidates: Object.freeze(selection.candidates),
    records: Object.freeze(selection.records)
  });
}

function emptyGlobalRecallCandidatesResult(): Readonly<{
  readonly total_scanned: number;
  readonly candidates: readonly Readonly<GlobalMemoryRecallCandidate>[];
  readonly records: readonly Readonly<GlobalMemoryRecallRecord>[];
}> {
  return Object.freeze({
    total_scanned: 0,
    candidates: Object.freeze([]),
    records: Object.freeze([])
  });
}

function buildGlobalRecallSelection(
  params: Parameters<typeof loadGlobalRecallCandidates>[0],
  surfacedEntries: readonly Readonly<GlobalMemoryRecallEntry>[],
  anchorMap: ReadonlyMap<string, Readonly<ProjectMappingAnchor>>
): Readonly<{
  readonly candidates: readonly Readonly<GlobalMemoryRecallCandidate>[];
  readonly records: readonly Readonly<GlobalMemoryRecallRecord>[];
}> {
  const candidates: GlobalMemoryRecallCandidate[] = [];
  const records = surfacedEntries.map((entry) =>
    buildGlobalRecallRecord(params, entry, anchorMap, candidates)
  );
  return Object.freeze({
    candidates: Object.freeze(candidates),
    records: Object.freeze(records)
  });
}

function buildGlobalRecallRecord(
  params: Parameters<typeof loadGlobalRecallCandidates>[0],
  entry: Readonly<GlobalMemoryRecallEntry>,
  anchorMap: ReadonlyMap<string, Readonly<ProjectMappingAnchor>>,
  candidates: GlobalMemoryRecallCandidate[]
): Readonly<GlobalMemoryRecallRecord> {
  const classification = params.classifyGlobalCandidate(entry, anchorMap);
  const candidate = buildGlobalRecallCandidate(params, entry, classification);
  if (candidate !== null) {
    candidates.push(candidate);
  }
  return Object.freeze({
    globalObjectId: entry.global_object_id,
    candidate
  });
}

function buildGlobalRecallCandidate(
  params: Parameters<typeof loadGlobalRecallCandidates>[0],
  entry: Readonly<GlobalMemoryRecallEntry>,
  classification: GlobalCandidateClassification
): Readonly<GlobalMemoryRecallCandidate> | null {
  if (!classification.include) {
    return null;
  }
  const pseudoEntry = createPseudoMemoryEntry(entry, params.workspaceId);
  const matchesTimeFilter = params.entryMatchesTimeFilter;
  const passesTimeWindow =
    matchesTimeFilter === undefined
      ? true
      : matchesTimeFilter(pseudoEntry, params.timeFilter);
  if (!passesTimeWindow) {
    return null;
  }
  return Object.freeze({
    entry: pseudoEntry,
    originPlane: "global" as const,
    isAdvisory: false
  });
}

export function createGlobalMemoryRecallPort(params: {
  readonly globalMemorySource: GlobalMemoryRecallSourcePort;
}): GlobalMemoryRecallServicePort {
  return new GlobalMemoryRecallService(params.globalMemorySource);
}

// Bounded LRU supplement cache keyed by workspaceId, queryText, and limit.
const GLOBAL_RECALL_QUERY_CACHE_SIZE = 512;

class GlobalMemoryRecallService implements GlobalMemoryRecallServicePort {
  private readonly cacheByQuery = new Map<string, readonly Readonly<GlobalMemoryRecallEntry>[]>();

  public constructor(private readonly globalMemorySource: GlobalMemoryRecallSourcePort) {}

  public async recall(params: {
    readonly workspaceId: string;
    readonly queryText: string | null;
    readonly limit: number;
  }): Promise<readonly Readonly<GlobalMemoryRecallEntry>[]> {
    const cacheKey = createRecallCacheKey(params);
    const cached = this.cacheByQuery.get(cacheKey);
    if (cached !== undefined) {
      // Refresh recency: re-insert so the most-recently-read key is youngest.
      this.cacheByQuery.delete(cacheKey);
      this.cacheByQuery.set(cacheKey, cached);
      return [...cached];
    }

    const normalizedQuery = normalizeGlobalMemoryQuery(params.queryText);
    const selectedEntries = await selectGlobalMemoryRecallEntries(
      this.globalMemorySource,
      normalizedQuery,
      params.limit
    );
    const recallEntries = selectedEntries.map((entry) =>
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

    this.cacheByQuery.delete(cacheKey);
    this.cacheByQuery.set(cacheKey, recallEntries);
    while (this.cacheByQuery.size > GLOBAL_RECALL_QUERY_CACHE_SIZE) {
      const oldestKey = this.cacheByQuery.keys().next().value as string | undefined;
      if (oldestKey === undefined) {
        break;
      }
      this.cacheByQuery.delete(oldestKey);
    }
    return [...recallEntries];
  }

  public subscribeToInvalidations(
    notifier: GlobalMemoryRecallInvalidationNotifier
  ): GlobalMemoryRecallSubscription {
    return notifier.subscribeEntries((entry) => {
      const invalidation = parseMemoryInvalidationEntry(entry);
      if (invalidation === null) {
        return;
      }

      this.invalidateForMemory(invalidation.memoryId, invalidation.sourceWorkspaceId);
    });
  }

  private invalidateForMemory(memoryId: string, sourceWorkspaceId: string): void {
    void sourceWorkspaceId;
    for (const [cacheKey, cachedEntries] of this.cacheByQuery.entries()) {
      if (!cachedEntries.some((entry) => entry.global_object_id === memoryId)) {
        continue;
      }

      this.cacheByQuery.delete(cacheKey);
    }
  }
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
  if (queryText === null) return null;
  const tokens = queryText
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0);

  return tokens.length === 0 ? null : tokens;
}

function createRecallCacheKey(params: {
  readonly workspaceId: string;
  readonly queryText: string | null;
  readonly limit: number;
}): string {
  return `${params.workspaceId}\u001f${params.queryText ?? ""}\u001f${params.limit}`;
}

const memoryInvalidationEventTypes = new Set([
  "memory.created", "memory.updated", "memory.deleted",
  "soul.memory.created", "soul.memory.updated", "soul.memory.archived"
]);

function parseMemoryInvalidationEntry(
  entry: Readonly<EventLogEntry>
): Readonly<{
  readonly memoryId: string;
  readonly sourceWorkspaceId: string;
}> | null {
  if (!memoryInvalidationEventTypes.has(entry.event_type)) {
    return null;
  }

  const payload = toObjectRecord(entry.payload_json);
  const sourceWorkspaceId = readNonEmptyString(entry.workspace_id) ?? readNonEmptyProperty(payload, "workspace_id");
  if (sourceWorkspaceId === null) {
    return null;
  }

  const memoryId =
    readNonEmptyProperty(payload, "memory_id") ??
    readNonEmptyProperty(payload, "object_id") ??
    (entry.entity_type === "memory_entry" ? readNonEmptyString(entry.entity_id) : null);

  if (memoryId === null) {
    return null;
  }

  return Object.freeze({
    memoryId,
    sourceWorkspaceId
  });
}

function toObjectRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function readNonEmptyProperty(
  value: Readonly<Record<string, unknown>> | null,
  key: string
): string | null {
  if (value === null) {
    return null;
  }

  return readNonEmptyString(value[key]);
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function createPseudoMemoryEntry(
  entry: Readonly<GlobalMemoryRecallEntry>,
  workspaceId: string
): Readonly<MemoryEntry> {
  const pseudoRunId = `global:${entry.global_object_id}`;
  const scopeClass = ScopeClassSchema.safeParse(entry.scope_class);

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
    scope_class: scopeClass.success ? scopeClass.data : "project",
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
