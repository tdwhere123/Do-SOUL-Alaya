import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  AcceptedBy,
  DEFAULT_SOUL_CONFIG,
  DYNAMICS_CONSTANTS,
  MemoryGovernanceEventType,
  ProjectMappingState,
  type PathAnchorRef,
  type PathRelation,
  type AgentRuntimePort,
  type EngineBinding,
  type EngineBindingSummary,
  type EventLogEntry,
  type GlobalMemoryEntry,
  type GardenBacklogThresholds,
  type SoulGraph,
  type SoulGraphOriginKind
} from "@do-soul/alaya-protocol";
import {
  ArbitrationService,
  CanonicalAliasService,
  ClaimService,
  CoreError,
  ProjectMappingService,
  StrongRefService,
  ToolGovernanceClient,
  SqliteKarmaEventStore,
  createGlobalMemoryRecallPort as createCoreGlobalMemoryRecallPort,
  type GlobalMemoryRecallCachePort,
  type GlobalMemoryRecallServicePort
} from "@do-soul/alaya-core";
import * as StorageModule from "@do-soul/alaya-storage";
import {
  SqliteEventLogRepo,
  SqliteGlobalMemoryRecallCacheRepo,
  SqliteGlobalMemoryRepo,
  SqliteKarmaEventRepo,
  SqliteMemoryEntryRepo,
  type ProposalRepo,
  SqliteToolExecutionRecordRepo,
  type GlobalMemoryRecallCacheRepo,
  type GlobalMemoryRepo,
  type MemoryEmbeddingRepo,
  type PathRelationRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { createWarnLogger } from "./daemon-runtime-helpers.js";
import type { RequestProtectionConfig } from "../app.js";
import type { AlayaConfigPaths } from "../cli/config-files.js";
import type { DaemonStartupStepRecord } from "./daemon-runtime-types.js";
import { parseEnv } from "../services/env-file-service.js";
import { resolveConfiguredDatabasePath } from "./storage-config.js";
import { isNodeErrorWithCode } from "../services/private-file-service.js";
import { resolveSecretRef, type ResolveSecretError } from "../secrets.js";
import type { AlayaRuntimeNotifier } from "./runtime-notifier.js";

export const DEFAULT_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
export const ALAYA_OFFICIAL_GARDEN_SECRET_REF_ENV = "ALAYA_OFFICIAL_GARDEN_SECRET_REF";
const GARDEN_BACKLOG_REARM_RATIO = 0.7;
const GARDEN_BACKLOG_SNAPSHOT_INTERVAL_MS = 60_000;

type GlobalMemoryListFilters = Parameters<GlobalMemoryRepo["list"]>[0];
type MemoryEntryRecord = Awaited<ReturnType<SqliteMemoryEntryRepo["findByWorkspaceId"]>>[number];

export function createRequestProtection(): RequestProtectionConfig {
  return Object.freeze({
    allowedOrigin: process.env.ALLOWED_ORIGIN ?? "http://localhost:5173",
    requestToken: process.env.ALAYA_REQUEST_TOKEN ?? randomBytes(32).toString("hex"),
    allowDesktopOriginlessRequests: true
  });
}

export function recordStartupStep(
  startupSteps: DaemonStartupStepRecord[],
  step: DaemonStartupStepRecord["step"]
): void {
  startupSteps.push({
    step,
    completedAt: new Date().toISOString()
  });
}

export async function listServerHardConstraints(_workspaceId: string) {
  return Object.freeze([
    Object.freeze({
      ref: "constraint://worker-dispatch",
      content: "Never mutate files outside approved workspace roots."
    })
  ]);
}

export async function resolveDatabasePath(
  configPaths: AlayaConfigPaths,
  fallbackPath: string
): Promise<string> {
  return await resolveConfiguredDatabasePath(configPaths, {
    env: process.env,
    fallbackPath
  });
}

export function createGardenBacklogThresholds(): GardenBacklogThresholds {
  const warningQueueDepth = DEFAULT_SOUL_CONFIG.garden_backlog_soft_limit;

  return {
    warning_queue_depth: warningQueueDepth,
    warning_rearm_depth: Math.max(0, Math.floor(warningQueueDepth * GARDEN_BACKLOG_REARM_RATIO)),
    snapshot_interval_ms: GARDEN_BACKLOG_SNAPSHOT_INTERVAL_MS
  };
}

export async function loadConfigEnv(envPath: string): Promise<ReadonlyMap<string, string>> {
  try {
    return parseEnv(await readFile(envPath, "utf8"));
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) {
      return new Map();
    }
    throw error;
  }
}

export function readConfigEnvValue(configEnv: ReadonlyMap<string, string>, key: string): string | undefined {
  return process.env[key] ?? configEnv.get(key);
}

export function readNonEmptyEnv(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function readOptionalSecretRef(value: string | undefined, label: string): string | null {
  const rawValue = readNonEmptyEnv(value);
  if (rawValue === null) {
    return null;
  }

  const resolved = resolveSecretRef(rawValue);
  if ("kind" in resolved) {
    throw new Error(formatSecretResolutionError(label, resolved));
  }

  return resolved.value;
}

export function readOfficialGardenSecretRef(configEnv: ReadonlyMap<string, string>): string | null {
  return readOptionalSecretRef(
    readConfigEnvValue(configEnv, ALAYA_OFFICIAL_GARDEN_SECRET_REF_ENV),
    ALAYA_OFFICIAL_GARDEN_SECRET_REF_ENV
  );
}

export const ALAYA_EDGE_PRODUCER_LLM_ENABLED_ENV = "ALAYA_EDGE_PRODUCER_LLM_ENABLED";
export const ALAYA_EDGE_CLASSIFY_HOST_WORKER_ENV = "ALAYA_EDGE_CLASSIFY_HOST_WORKER";

// invariant: the B-2 edge-classify routing mode. Mutually exclusive by
// construction: host-worker defer wins over the synchronous cloud LLM, which
// wins over the local heuristic-only floor.
//   - "host_worker_defer": the EDGE_CLASSIFY garden task is enqueued for an
//     attached CLI agent (the compute). No cloud call. This is the product
//     default whenever the resolved garden compute provider_kind is
//     host_worker, or when ALAYA_EDGE_CLASSIFY_HOST_WORKER forces it on.
//   - "cloud_llm": the operator strict-opted-in via ALAYA_EDGE_PRODUCER_LLM_ENABLED
//     AND host-worker defer is NOT active. The synchronous in-process cloud
//     port is then attempted (it still needs a resolvable key + provider_url,
//     resolved separately; this mode reports the INTENT to call cloud).
//   - "heuristic_only": neither defer nor opt-in — the deterministic heuristic
//     is the only classifier; zero external call.
export type EdgeClassifyWiringMode = "host_worker_defer" | "cloud_llm" | "heuristic_only";

export interface EdgeClassifyWiring {
  readonly mode: EdgeClassifyWiringMode;
  // strict opt-in for the synchronous cloud edge-LLM (1/true only).
  readonly llmEnabled: boolean;
  // host-worker defer is on (explicit override OR provider_kind=host_worker default).
  readonly hostWorkerEnabled: boolean;
}

function readBooleanOptIn(raw: string | undefined): boolean {
  const value = raw?.toLowerCase();
  return value === "1" || value === "true";
}

// invariant: the single decision that chooses cloud llmPort vs the
// host-worker EDGE_CLASSIFY defer queue vs heuristic-only for B-2 edge
// classification. PURE: depends only on the passed env reader and the resolved
// garden compute provider_kind, so the zero-cloud-by-default guarantee is unit
// testable without standing up the daemon. index.ts consumes this; behavior
// must not diverge between the two. A regression that flips the default back
// to cloud changes this function's output and is caught by its tests.
// see also: apps/core-daemon/src/index.ts edgeAutoProducerLlmPort /
//   edgeClassifyHostWorkerEnabled wiring.
export function resolveEdgeClassifyWiring(
  env: Readonly<Record<string, string | undefined>>,
  gardenComputeConfig: { readonly provider_kind: string }
): EdgeClassifyWiring {
  const llmEnabled = readBooleanOptIn(env[ALAYA_EDGE_PRODUCER_LLM_ENABLED_ENV]);
  const hostWorkerRaw = env[ALAYA_EDGE_CLASSIFY_HOST_WORKER_ENV]?.toLowerCase();
  const hostWorkerEnabled =
    hostWorkerRaw === "1" || hostWorkerRaw === "true"
      ? true
      : hostWorkerRaw === "0" || hostWorkerRaw === "false"
        ? false
        : gardenComputeConfig.provider_kind === "host_worker";
  const mode: EdgeClassifyWiringMode = hostWorkerEnabled
    ? "host_worker_defer"
    : llmEnabled
      ? "cloud_llm"
      : "heuristic_only";
  return { mode, llmEnabled, hostWorkerEnabled };
}

export function createOptionalMemoryEmbeddingRepo(database: StorageDatabase): MemoryEmbeddingRepo | null {
  const RepoCtor = StorageModule.SqliteMemoryEmbeddingRepo;
  if (typeof RepoCtor !== "function" || !supportsPreparedSqliteConnection(database)) {
    return null;
  }

  return new RepoCtor(database);
}

export function createOptionalGlobalMemoryRepo(database: StorageDatabase): GlobalMemoryRepo | null {
  if (!supportsPreparedSqliteConnection(database)) {
    return null;
  }

  return new SqliteGlobalMemoryRepo(database);
}

export function createOptionalGlobalMemoryRecallCacheRepo(
  database: StorageDatabase
): GlobalMemoryRecallCacheRepo | null {
  if (!supportsPreparedSqliteConnection(database)) {
    return null;
  }

  return new SqliteGlobalMemoryRecallCacheRepo(database);
}

export function createGlobalMemoryRouteService(params: {
  readonly globalMemoryRepo: GlobalMemoryRepo;
  readonly projectMappingService: ProjectMappingService;
}) {
  return {
    list: async (input: { readonly dimension?: string; readonly scope_class?: string; readonly limit: number }) => {
      const entries = await params.globalMemoryRepo.list({
        ...(input.dimension === undefined ? {} : { dimension: input.dimension }),
        ...(input.scope_class === undefined ? {} : { scope_class: input.scope_class })
      } as GlobalMemoryListFilters);

      return input.limit >= entries.length ? entries : entries.slice(0, input.limit);
    },
    adopt: async (
      globalObjectId: string,
      input: { readonly workspace_id: string; readonly accepted_by?: AcceptedBy }
    ) => await adoptGlobalMemoryEntry(params.globalMemoryRepo, params.projectMappingService, globalObjectId, input)
  };
}

export function createGlobalMemoryRecallPort(params: {
  readonly globalMemoryRepo: GlobalMemoryRepo;
}): GlobalMemoryRecallServicePort {
  return createCoreGlobalMemoryRecallPort({
    globalMemorySource: {
      list: async () => await params.globalMemoryRepo.list()
    }
  });
}

export function createGlobalMemoryRecallCachePort(params: {
  readonly globalMemoryRecallCacheRepo: GlobalMemoryRecallCacheRepo;
  readonly now?: () => string;
}): GlobalMemoryRecallCachePort {
  const now = params.now ?? (() => new Date().toISOString());

  return {
    recordClassifications: async (records) => {
      const updatedAt = now();
      await params.globalMemoryRecallCacheRepo.upsertMany(
        records.map((record) => ({
          workspace_id: record.workspaceId,
          global_object_id: record.globalObjectId,
          classification: record.classification,
          updated_at: updatedAt
        }))
      );
    }
  };
}

export function createSoulGraphService(input: {
  readonly memoryEntryRepo: SqliteMemoryEntryRepo;
  readonly pathRelationRepo: Pick<PathRelationRepo, "findActive">;
  readonly proposalRepo: Pick<
    ProposalRepo,
    "findPendingSummaries" | "countPending" | "countPendingMemoryTargetEdges"
  >;
  readonly eventLogRepo: Pick<SqliteEventLogRepo, "queryByWorkspaceAndType">;
  readonly now?: () => string;
}) {
  return {
    buildSoulGraph: async ({
      workspaceId,
      limit
    }: {
      readonly workspaceId: string;
      readonly depth: number;
      readonly limit: number;
    }): Promise<SoulGraph> => {
      const [
        memories,
        pathRelations,
        pendingProposals,
        pendingProposalsTotal,
        memoryUpdateEvents
      ] = await Promise.all([
        input.memoryEntryRepo.findByWorkspaceId(workspaceId),
        input.pathRelationRepo.findActive(workspaceId),
        input.proposalRepo.findPendingSummaries(workspaceId, {
          limit,
          now: input.now?.()
        }),
        input.proposalRepo.countPending(workspaceId),
        input.eventLogRepo.queryByWorkspaceAndType(
          workspaceId,
          MemoryGovernanceEventType.SOUL_MEMORY_UPDATED
        )
      ]);
      const allMemoryIds = memories.map((memory) => memory.object_id);
      const allMemoryIdSet = new Set(allMemoryIds);
      const pendingProposalEdgesTotal =
        await input.proposalRepo.countPendingMemoryTargetEdges(workspaceId, allMemoryIds);
      const limitedMemories = memories.slice(0, limit);
      const memoryIds = new Set(limitedMemories.map((memory: MemoryEntryRecord) => memory.object_id));
      // invariant: the Inspector graph view shows only PathRelation edges —
      // the unified plane carries strength + stability + last_reinforced_at
      // metadata the visual encoding depends on. memory_graph_edges is no
      // longer read here (no producer writes it; accept mints paths).
      const pathRelationEdges = buildPathRelationEdges(pathRelations, memoryIds).slice(0, limit);
      const tagProjection = buildDomainTagProjection(limitedMemories);
      const influenceCounts = buildInfluenceCounts(pathRelations);
      const proposalProjection = buildPendingProposalProjection(pendingProposals, memoryIds);
      const userReviewedMemoryIds = buildUserReviewedMemoryIds(memoryUpdateEvents);

      return {
        workspace_id: workspaceId,
        nodes: [
          ...limitedMemories.map((memory: MemoryEntryRecord) => {
            const label = deriveMemoryNodeLabel(memory.content);
            const summary = deriveMemoryNodeSummary(memory.content, label);
            const hasAcceptedProposalApply = userReviewedMemoryIds.has(memory.object_id);
            const node: SoulGraph["nodes"][number] = {
              id: memory.object_id,
              kind: "memory",
              label,
              workspace_id: memory.workspace_id,
              created_at: memory.created_at,
              scope_id: memory.scope_class,
              origin_plane: memory.scope_class === "project" ? "project" : "global",
              origin_kind: classifySoulGraphOriginKind(
                memory,
                hasAcceptedProposalApply
              ),
              evidence_refs: memory.evidence_refs.length === 0 ? undefined : [...memory.evidence_refs],
              rationale: deriveMemoryRationale(memory, hasAcceptedProposalApply),
              confidence: memory.confidence ?? undefined,
              last_used_at: memory.last_used_at ?? undefined,
              last_hit_at: memory.last_hit_at ?? undefined,
              influence_count: influenceCounts.get(memory.object_id) ?? 0
            };
            return summary === undefined ? node : { ...node, summary };
          }),
          ...proposalProjection.nodes,
          ...tagProjection.nodes
        ],
        edges: [
          ...pathRelationEdges,
          ...proposalProjection.edges,
          ...tagProjection.edges
        ],
        truncated:
          memories.length > limitedMemories.length ||
          pathRelations.length > pathRelationEdges.length ||
          pendingProposalsTotal > pendingProposals.length,
        // Use the cheap COUNT(*) over pending proposals, NOT pendingProposals.length:
        // findPendingSummaries SQL-LIMITs to `limit`, so pendingProposals.length is
        // capped and would understate node_total when more than `limit` proposals are
        // pending — the inspector "sampled vs complete" chip would silently lie.
        node_total: memories.length + pendingProposalsTotal + countUniqueDomainTags(memories),
        edge_total:
          countPathRelationEdges(pathRelations, allMemoryIdSet) +
          pendingProposalEdgesTotal +
          countDomainTagEdges(memories)
      };
    }
  };
}

export function classifySoulGraphOriginKind(
  memory: Pick<
    MemoryEntryRecord,
    | "source_kind"
    | "formation_kind"
    | "created_by"
    | "evidence_refs"
    | "content"
    | "domain_tags"
    | "run_id"
  >,
  hasAcceptedProposalApply = false
): SoulGraphOriginKind {
  // invariant: reviewer acceptance adds governance state without overwriting
  // the entry's true engineering-origin attribution. Engineering-origin
  // signals fan out across multiple persisted fields because import paths
  // historically populate them inconsistently — `evidence_refs` carries
  // internal UUIDs (not file paths) for the codex-memory-import bulk
  // pipeline, so classifier must also read `content`, `domain_tags`, and
  // `run_id` to recover the same attribution.
  // invariant: source_kind="user"/"review" beats every soft engineering
  // signal. The substring fallbacks below recover engineering attribution
  // for bulk codex imports whose source_kind is "compiler" — they must NOT
  // override an explicit user-curated source. Otherwise a user note that
  // mentions .codex/memories or carries a tag with "codex-memory-import"
  // would be silently relabeled as engineering.
  const isUserOrigin = memory.source_kind === "user" || memory.source_kind === "review";
  if (isUserOrigin) {
    return "user_memory";
  }

  const tagsContainCodex = memory.domain_tags.some((tag) =>
    tag.toLowerCase().includes("codex-memory-import")
  );
  const runIdMarksCodex = memory.run_id.toLowerCase().includes("codex-memory-import");
  const contentMentionsCodexMemories = memory.content.includes(".codex/memories");

  const isEngineeringOrigin =
    memory.source_kind === "import" ||
    memory.formation_kind === "imported" ||
    memory.created_by.toLowerCase().includes("codex") ||
    memory.evidence_refs.some((ref) => ref.includes(".codex/memories")) ||
    tagsContainCodex ||
    runIdMarksCodex ||
    contentMentionsCodexMemories;

  if (isEngineeringOrigin) {
    return hasAcceptedProposalApply ? "reviewed_engineering_chunk" : "engineering_chunk";
  }
  if (hasAcceptedProposalApply) {
    return "user_memory";
  }
  return "system";
}

function buildUserReviewedMemoryIds(events: readonly EventLogEntry[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (
      event.entity_type === "memory_entry" &&
      event.caused_by?.startsWith("proposal_accept:") === true
    ) {
      ids.add(event.entity_id);
    }
  }
  return ids;
}

function deriveMemoryRationale(
  memory: Pick<MemoryEntryRecord, "source_kind" | "formation_kind">,
  hasAcceptedProposalApply: boolean
): string {
  if (hasAcceptedProposalApply) {
    return "Human-reviewed proposal applied to this memory.";
  }
  if (memory.source_kind === "user" || memory.source_kind === "review") {
    return "Explicit user or reviewer-governed memory.";
  }
  if (memory.source_kind === "import" || memory.formation_kind === "imported") {
    return "Imported engineering context.";
  }
  if (memory.source_kind === "seed") {
    return "System bootstrap seed.";
  }
  return "Compiled from governed runtime signals.";
}

function buildPathRelationEdges(
  relations: readonly Readonly<PathRelation>[],
  memoryIds: ReadonlySet<string>
): readonly SoulGraph["edges"][number][] {
  return relations.flatMap((relation) => {
    const sourceId = anchorMemoryId(relation.anchors.source_anchor);
    const targetId = anchorMemoryId(relation.anchors.target_anchor);
    if (
      sourceId === undefined ||
      targetId === undefined ||
      !memoryIds.has(sourceId) ||
      !memoryIds.has(targetId) ||
      sourceId === targetId
    ) {
      return [];
    }
    const strength = normalizePathStrength(relation.plasticity_state.strength);
    return [
      {
        id: relation.path_id,
        kind: "references" as const,
        source_id: sourceId,
        target_id: targetId,
        weight: strength,
        strength_normalized: strength,
        stability_class: relation.plasticity_state.stability_class,
        last_reinforced_at: relation.plasticity_state.last_reinforced_at,
        created_at: relation.created_at
      }
    ];
  });
}

function buildInfluenceCounts(
  relations: readonly Readonly<PathRelation>[]
): ReadonlyMap<string, number> {
  const influence = new Map<string, number>();
  for (const relation of relations) {
    const anchors = new Set(
      [relation.anchors.source_anchor, relation.anchors.target_anchor]
        .map(anchorMemoryId)
        .filter((id): id is string => id !== undefined)
    );
    const increment = 1 + relation.plasticity_state.support_events_count;
    for (const memoryId of anchors) {
      influence.set(memoryId, (influence.get(memoryId) ?? 0) + increment);
    }
  }
  return influence;
}

function buildPendingProposalProjection(
  proposals: Awaited<ReturnType<ProposalRepo["findPendingSummaries"]>>,
  memoryIds: ReadonlySet<string>
): {
  readonly nodes: readonly SoulGraph["nodes"][number][];
  readonly edges: readonly SoulGraph["edges"][number][];
  readonly total_edges: number;
} {
  const nodes: SoulGraph["nodes"][number][] = [];
  const edges: SoulGraph["edges"][number][] = [];

  for (const proposal of proposals) {
    const proposalNodeId = `proposal:${proposal.proposal_id}`;
    nodes.push({
      id: proposalNodeId,
      kind: "projection",
      label: `Proposal ${proposal.proposal_id}`,
      ...(proposal.proposed_change_summary.length === 0
        ? {}
        : { summary: proposal.proposed_change_summary }),
      created_at: proposal.created_at,
      scope_id: proposal.target_object_id,
      origin_kind: "proposal_pending"
    });
    if (memoryIds.has(proposal.target_object_id)) {
      edges.push({
        id: `proposal:${proposal.proposal_id}:target`,
        kind: "derived_from",
        source_id: proposalNodeId,
        target_id: proposal.target_object_id,
        created_at: proposal.created_at
      });
    }
  }

  return { nodes, edges, total_edges: edges.length };
}

function anchorMemoryId(anchor: PathAnchorRef): string | undefined {
  switch (anchor.kind) {
    case "object":
    case "object_facet":
      return anchor.object_id;
    case "obligation":
    case "risk_concern":
    case "time_concern":
      return anchor.source_object_id;
    default:
      return undefined;
  }
}

function countPathRelationEdges(
  relations: readonly Readonly<PathRelation>[],
  memoryIds: ReadonlySet<string>
): number {
  return relations.reduce((count, relation) => {
    const sourceId = anchorMemoryId(relation.anchors.source_anchor);
    const targetId = anchorMemoryId(relation.anchors.target_anchor);
    return sourceId !== undefined &&
      targetId !== undefined &&
      sourceId !== targetId &&
      memoryIds.has(sourceId) &&
      memoryIds.has(targetId)
      ? count + 1
      : count;
  }, 0);
}

function normalizePathStrength(value: number): number {
  const floor = DYNAMICS_CONSTANTS.path_plasticity.strength_floor;
  const ceiling = DYNAMICS_CONSTANTS.path_plasticity.strength_ceiling;
  if (ceiling <= floor) {
    return clamp01(value);
  }
  return clamp01((value - floor) / (ceiling - floor));
}

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function buildDomainTagProjection(memories: readonly MemoryEntryRecord[]): {
  readonly nodes: readonly SoulGraph["nodes"][number][];
  readonly edges: readonly SoulGraph["edges"][number][];
} {
  const tagMembers = new Map<string, MemoryEntryRecord[]>();
  const tagEdges: SoulGraph["edges"][number][] = [];

  for (const memory of memories) {
    for (const tag of uniqueDomainTags(memory)) {
      let members = tagMembers.get(tag);
      if (!members) {
        members = [];
        tagMembers.set(tag, members);
      }
      members.push(memory);
      tagEdges.push({
        id: `domain_tag:${memory.object_id}:${tag}`,
        kind: "belongs_to",
        source_id: memory.object_id,
        target_id: domainTagNodeId(tag),
        created_at: memory.created_at
      });
    }
  }

  return {
    nodes: [...tagMembers.entries()].map(([tag, members]) => ({
      id: domainTagNodeId(tag),
      kind: "scope",
      label: `#${tag}`,
      summary: deriveDomainTagSummary(members),
      scope_id: `domain_tag:${tag}`,
      origin_plane: "project"
    })),
    edges: tagEdges
  };
}

const MEMORY_NODE_LABEL_MAX = 80;
const MEMORY_NODE_SUMMARY_MAX = 280;
const DOMAIN_TAG_SAMPLE_LIMIT = 3;
const DOMAIN_TAG_SAMPLE_LABEL_MAX = 32;

function deriveMemoryNodeLabel(content: string): string {
  const firstLine = content.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (firstLine.length > 0) {
    return truncateWithEllipsis(firstLine, MEMORY_NODE_LABEL_MAX);
  }
  const fallback = content.trim();
  if (fallback.length === 0) {
    return "(empty)";
  }
  return truncateWithEllipsis(fallback, MEMORY_NODE_LABEL_MAX);
}

function deriveMemoryNodeSummary(content: string, label: string): string | undefined {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (trimmed === label) {
    return undefined;
  }
  return truncateWithEllipsis(trimmed, MEMORY_NODE_SUMMARY_MAX);
}

export function deriveDomainTagSummary(members: readonly MemoryEntryRecord[]): string {
  const count = members.length;
  // Dedupe sample labels: a tag like #codex-memory-recall-shard with 226
  // members all sharing the same truncated firstLine ("Codex memory recall
  // shard (2026-…)") would otherwise render as the same string repeated
  // three times. Walk every member, collect distinct truncated labels, and
  // surface a count of remaining variants so the operator can tell whether
  // the bucket is uniform or heterogeneous.
  const distinctLabels: string[] = [];
  const seenLabels = new Set<string>();
  for (const member of members) {
    const sample = truncateWithEllipsis(
      deriveMemoryNodeLabel(member.content),
      DOMAIN_TAG_SAMPLE_LABEL_MAX
    );
    if (!seenLabels.has(sample)) {
      seenLabels.add(sample);
      distinctLabels.push(sample);
    }
  }
  const noun = count === 1 ? "memory" : "memories";
  if (distinctLabels.length === 0) {
    return `${count} ${noun}`;
  }
  if (distinctLabels.length === 1 && count > 1) {
    return `${count} ${noun} · all: ${distinctLabels[0]}`;
  }
  const visible = distinctLabels.slice(0, DOMAIN_TAG_SAMPLE_LIMIT);
  const remainingVariants = distinctLabels.length - visible.length;
  const tail =
    remainingVariants > 0
      ? ` · +${remainingVariants} more variant${remainingVariants === 1 ? "" : "s"}`
      : "";
  return `${count} ${noun} · ${visible.join(" · ")}${tail}`;
}

function truncateWithEllipsis(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, max - 1)}…`;
}

function uniqueDomainTags(memory: MemoryEntryRecord): readonly string[] {
  const tags = Array.isArray(memory.domain_tags) ? memory.domain_tags : [];
  return [...new Set(tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0))];
}

function countUniqueDomainTags(memories: readonly MemoryEntryRecord[]): number {
  return new Set(memories.flatMap((memory) => uniqueDomainTags(memory))).size;
}

function countDomainTagEdges(memories: readonly MemoryEntryRecord[]): number {
  return memories.reduce((count, memory) => count + uniqueDomainTags(memory).length, 0);
}

function domainTagNodeId(tag: string): string {
  return `scope:domain_tag:${tag}`;
}

export function createConversationToolExecutor(input: {
  readonly eventLogRepo: SqliteEventLogRepo;
  readonly runtimeNotifier: AlayaRuntimeNotifier;
  readonly toolExecutionRecordRepo: SqliteToolExecutionRecordRepo;
  readonly toolGovernanceClient: ToolGovernanceClient;
  readonly targetRevalidateService: unknown;
  readonly strongRefService: StrongRefService;
  readonly canonicalAliasService: CanonicalAliasService;
}) {
  void input.toolGovernanceClient;
  void input.targetRevalidateService;
  void input.strongRefService;
  void input.canonicalAliasService;

  return {
    execute: async (request: {
      readonly toolId: string;
      readonly rawInput: unknown;
      readonly runtimeContext: { readonly run_id: string; readonly workspace_id: string };
      readonly workspaceRoot: string;
      readonly affectedPathRoots?: readonly string[];
      readonly handler: (context: { readonly writableRoots: readonly string[] }, rawInput?: unknown) => Promise< unknown>;
    }) => {
      const startedAt = new Date().toISOString();
      const result = await request.handler(
        { writableRoots: [request.workspaceRoot] },
        request.rawInput
      );
      const endedAt = new Date().toISOString();
      const executionId = randomUUID();
      const affectedPaths = request.affectedPathRoots ?? [];

      await input.toolExecutionRecordRepo.insert({
        execution_id: executionId,
        tool_id: request.toolId,
        requested_by: "principal",
        requesting_run_id: request.runtimeContext.run_id,
        governance_decision_ref: "fast-path://recorded",
        permission_result: "allow",
        executed: true,
        started_at: startedAt,
        ended_at: endedAt,
        result_summary: summarizeToolResult(result),
        rollback_status: "none",
        affected_paths: affectedPaths
      });
      const event = await input.eventLogRepo.append({
        event_type: "tool_call.completed",
        entity_type: "tool_call",
        entity_id: executionId,
        workspace_id: request.runtimeContext.workspace_id,
        run_id: request.runtimeContext.run_id,
        caused_by: "principal",
        payload_json: {
          tool_call_id: executionId,
          tool_id: request.toolId,
          permission_result: "allow",
          executed: true,
          affected_paths: affectedPaths,
          result_summary: summarizeToolResult(result)
        }
      });
      await input.runtimeNotifier.notifyEntry(event);

      return { result };
    }
  };
}

export function createEngineBindingTester() {
  return {
    testBinding: async (binding: EngineBinding): Promise<EngineBindingSummary & { readonly available_models: readonly string[] }> => ({
      provider_type: binding.provider,
      base_url: binding.base_url ?? null,
      model: binding.model,
      available_models: []
    })
  };
}

export function createUnavailableRuntimeAdapter(): AgentRuntimePort {
  return {
    kind: "unavailable",
    getCapabilities: () => ({
      supports_resume: false,
      supports_interrupt: false,
      supports_streaming_updates: false,
      supports_tool_events: false,
      supports_permission_requests: false,
      supports_artifact_events: false,
      supports_terminal_events: false
    }),
    createSession: async () => {
      throw new Error("Principal runtime adapter is not configured.");
    },
    prompt: async () => {
      throw new Error("Principal runtime adapter is not configured.");
    },
    cancel: async (sessionId: string) => ({
      session_id: sessionId,
      status: "not_found",
      message: "Principal runtime adapter is not configured."
    }),
    onEvent: () => () => undefined
  };
}

export function createKarmaEventStore(
  karmaEventRepo: SqliteKarmaEventRepo,
  warnLogger: ReturnType<typeof createWarnLogger>
) {
  return new SqliteKarmaEventStore(karmaEventRepo, warnLogger);
}

export function patchArbitrationClaimService(arbitrationService: ArbitrationService, claimService: ClaimService): void {
  const dependencies = (arbitrationService as unknown as { dependencies?: { claimService?: ClaimService } }).dependencies;
  if (dependencies !== undefined) {
    dependencies.claimService = claimService;
  }
}

function formatSecretResolutionError(label: string, error: ResolveSecretError): string {
  switch (error.kind) {
    case "malformed":
      return `${label}: ${error.ref} -> ${error.reason}`;
    case "env_missing":
      return `${label}: ${error.ref} -> environment variable ${error.var_name} is not set`;
    case "file_missing":
      return `${label}: ${error.ref} -> file not found at ${error.path}`;
    case "file_unreadable":
      return `${label}: ${error.ref} -> file unreadable at ${error.path} (${error.cause})`;
    case "keychain_tooling_unavailable":
    case "keychain_entry_not_found":
      return `${label}: ${error.ref} -> ${error.reason}`;
    case "empty":
      return `${label}: ${error.ref} -> ${error.origin} secret is empty`;
  }
}

function supportsPreparedSqliteConnection(database: StorageDatabase): boolean {
  return typeof database.connection.prepare === "function";
}

async function adoptGlobalMemoryEntry(
  globalMemoryRepo: GlobalMemoryRepo,
  projectMappingService: ProjectMappingService,
  globalObjectId: string,
  input: { readonly workspace_id: string; readonly accepted_by?: AcceptedBy }
) {
  const entry = (await globalMemoryRepo.findByGlobalObjectId(globalObjectId)) as Readonly<GlobalMemoryEntry> | null;

  if (entry === null) {
    throw new CoreError("NOT_FOUND", `Global memory ${globalObjectId} was not found.`);
  }

  const acceptedBy = input.accepted_by ?? AcceptedBy.USER;
  const anchor = await projectMappingService.ensureAdoptableAnchor(
    entry.global_object_id,
    input.workspace_id,
    acceptedBy
  );

  if (anchor.mapping_state === ProjectMappingState.ACCEPTED) {
    return anchor;
  }

  return await projectMappingService.accept(anchor.object_id, acceptedBy);
}

function summarizeToolResult(result: unknown): string {
  if (typeof result === "object" && result !== null && "ok" in result) {
    return (result as { readonly ok?: boolean }).ok === false ? "error" : "ok";
  }

  return "ok";
}
