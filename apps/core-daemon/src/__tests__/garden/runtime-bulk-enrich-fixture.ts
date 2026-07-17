import { vi } from "vitest";
import {
  GardenTaskKind,
  type CandidateMemorySignal,
  type GardenTaskDescriptor
} from "@do-soul/alaya-protocol";
import { createGardenRuntime } from "../../garden/runtime.js";

export type GardenRuntimeInput = Parameters<typeof createGardenRuntime>[0];
export type ProduceFn = NonNullable<
  GardenRuntimeInput["enrichEdgeProducerPort"]
>["produceForNewMemory"];
export type DetectFn = NonNullable<
  GardenRuntimeInput["enrichConflictDetectionPort"]
>["detectAndLinkConflicts"];
export type ReplaySignalRefsFn = NonNullable<
  GardenRuntimeInput["enrichSignalRefReplayPort"]
>["replaySignalRefs"];
export type SourceSignalLookupFn = NonNullable<
  GardenRuntimeInput["enrichSourceSignalLookup"]
>["getById"];

interface PendingRow {
  workspaceId: string;
  memoryId: string;
  runId: string | null;
  sourceSignalId: string | null;
  claimedAt: string | null;
  processed: boolean;
  attemptCount: number;
  abandonedAt: string | null;
}

export class FakeEnrichPendingRepo {
  private readonly rows: PendingRow[] = [];
  private budgetCap: number | null = null;

  public setBudgetCap(cap: number | null): void {
    this.budgetCap = cap;
  }

  public enqueue(workspaceId: string, memoryId: string): void {
    const existing = this.rows.find((row) => row.workspaceId === workspaceId && row.memoryId === memoryId);
    if (existing !== undefined && !existing.processed) {
      return;
    }
    if (existing !== undefined) {
      existing.claimedAt = null;
      existing.processed = false;
      existing.attemptCount = 0;
      existing.abandonedAt = null;
      return;
    }
    this.rows.push({
      workspaceId,
      memoryId,
      runId: "run-1",
      sourceSignalId: `signal-${memoryId}`,
      claimedAt: null,
      processed: false,
      attemptCount: 0,
      abandonedAt: null
    });
  }

  public claimBatch(
    workspaceId: string,
    limit: number,
    claimedAt: string,
    maxAttempts: number
  ): readonly {
    readonly workspaceId: string;
    readonly memoryId: string;
    readonly runId: string | null;
    readonly sourceSignalId: string | null;
  }[] {
    const claimable = this.rows.filter(
      (row) =>
        row.workspaceId === workspaceId &&
        !row.processed &&
        row.claimedAt === null &&
        row.abandonedAt === null &&
        row.attemptCount < maxAttempts
    );
    const effectiveLimit = this.budgetCap === null ? limit : Math.min(limit, this.budgetCap);
    const claimed = claimable.slice(0, effectiveLimit);
    for (const row of claimed) {
      row.claimedAt = claimedAt;
    }
    return claimed.map((row) => ({
      workspaceId: row.workspaceId,
      memoryId: row.memoryId,
      runId: row.runId,
      sourceSignalId: row.sourceSignalId
    }));
  }

  public markProcessed(workspaceId: string, memoryId: string): void {
    const row = this.rows.find((entry) => entry.workspaceId === workspaceId && entry.memoryId === memoryId);
    if (row !== undefined) {
      row.processed = true;
    }
  }

  public recordFailedAttempt(
    workspaceId: string,
    memoryId: string,
    maxAttempts: number,
    abandonedAt: string
  ): { readonly attemptCount: number; readonly abandoned: boolean } {
    const row = this.rows.find((entry) => entry.workspaceId === workspaceId && entry.memoryId === memoryId);
    if (row === undefined || row.processed || row.abandonedAt !== null) {
      return { attemptCount: row?.attemptCount ?? 0, abandoned: false };
    }
    row.attemptCount += 1;
    if (row.attemptCount >= maxAttempts) {
      row.abandonedAt = abandonedAt;
      return { attemptCount: row.attemptCount, abandoned: true };
    }
    row.claimedAt = null;
    return { attemptCount: row.attemptCount, abandoned: false };
  }

  public delete(workspaceId: string, memoryId: string): void {
    const index = this.rows.findIndex(
      (entry) => entry.workspaceId === workspaceId && entry.memoryId === memoryId
    );
    if (index >= 0) {
      this.rows.splice(index, 1);
    }
  }

  public countPending(workspaceId: string): number {
    return this.rows.filter((row) => row.workspaceId === workspaceId && !row.processed).length;
  }

  public reclaimStale(now: string, staleAfterMs: number): number {
    const cutoff = new Date(new Date(now).getTime() - staleAfterMs).toISOString();
    let reclaimed = 0;
    for (const row of this.rows) {
      if (
        row.claimedAt !== null &&
        !row.processed &&
        row.abandonedAt === null &&
        row.claimedAt < cutoff
      ) {
        row.claimedAt = null;
        reclaimed += 1;
      }
    }
    return reclaimed;
  }

  public simulateStrandedClaim(workspaceId: string, memoryId: string, claimedAt: string): void {
    const row = this.rows.find((entry) => entry.workspaceId === workspaceId && entry.memoryId === memoryId);
    if (row === undefined) {
      throw new Error(`No enrich_pending row for ${workspaceId}/${memoryId}.`);
    }
    row.claimedAt = claimedAt;
    row.processed = false;
  }
}

export function buildMemory(
  memoryId: string,
  workspaceId = "workspace-1"
): Readonly<{
  readonly object_id: string;
  readonly dimension: string;
  readonly scope_class: string;
  readonly content: string;
  readonly domain_tags: readonly string[];
  readonly evidence_refs: readonly string[];
  readonly workspace_id: string;
  readonly run_id: string;
}> {
  return {
    object_id: memoryId,
    dimension: "fact",
    scope_class: "project",
    content: `content-for-${memoryId}`,
    domain_tags: ["rtk"],
    evidence_refs: [`evidence-for-${memoryId}`],
    workspace_id: workspaceId,
    run_id: "run-1"
  };
}

export function buildSignal(signalId: string): CandidateMemorySignal {
  return {
    signal_id: signalId,
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    source: "garden_compile",
    signal_kind: "potential_claim",
    object_kind: "fact",
    scope_hint: "project",
    domain_tags: ["rtk"],
    confidence: 0.9,
    evidence_refs: [],
    source_memory_refs: ["memory-source"],
    supersedes_refs: [],
    exception_to_refs: [],
    contradicts_refs: [],
    incompatible_with_refs: [],
    raw_payload: {
      distilled_fact: "Signal ref replay fact."
    },
    signal_state: "compiled",
    source_observation: null,
    created_at: "2026-05-30T12:00:00.000Z"
  };
}

export function bulkEnrichTask(): GardenTaskDescriptor {
  return {
    task_id: `bulk-${Math.random()}`,
    task_kind: GardenTaskKind.BULK_ENRICH,
    required_tier: "tier_2",
    workspace_id: "workspace-1",
    run_id: null,
    target_object_refs: ["workspace-1"],
    priority: 10,
    created_at: "2026-05-30T12:00:00.000Z"
  };
}

export function createRuntimeInput(options: {
  readonly enrichPendingRepo: FakeEnrichPendingRepo;
  readonly findById: (memoryId: string) => Promise<ReturnType<typeof buildMemory> | null>;
  readonly produceForNewMemory?: ProduceFn;
  readonly detectAndLinkConflicts?: DetectFn;
  readonly sourceSignalLookup?: SourceSignalLookupFn;
  readonly replaySignalRefs?: ReplaySignalRefsFn;
  readonly omitEnrichmentServices?: boolean;
  readonly workspaceIds?: readonly string[];
  readonly edgeProposalReconcile?: NonNullable<GardenRuntimeInput["edgeProposalReconcile"]>;
  readonly publish?: ReturnType<typeof vi.fn>;
}): GardenRuntimeInput {
  const fallbackPublish = vi.fn(async (entry: Record<string, unknown>) => ({
    event_id: `event-${fallbackPublish.mock.calls.length + 1}`,
    created_at: "2026-05-30T12:00:00.000Z",
    revision: 1,
    ...entry
  }));
  const publish = options.publish ?? fallbackPublish;
  const workspaceIds = options.workspaceIds ?? ["workspace-1"];

  return {
    databaseConnection: {} as GardenRuntimeInput["databaseConnection"],
    backlogThresholds: {
      warning_queue_depth: 100,
      warning_rearm_depth: 50,
      snapshot_interval_ms: 1000
    },
    eventLogRepo: {} as GardenRuntimeInput["eventLogRepo"],
    eventPublisher: {
      publish,
      appendManyWithMutation: vi.fn()
    } as unknown as GardenRuntimeInput["eventPublisher"],
    gardenDataPorts: {} as GardenRuntimeInput["gardenDataPorts"],
    healthJournalRepo: {
      append: vi.fn(async () => undefined)
    } as unknown as GardenRuntimeInput["healthJournalRepo"],
    handoffGapRepo: {
      findExpiredObjectsByWorkspace: vi.fn(async () => []),
      deleteById: vi.fn()
    } as unknown as GardenRuntimeInput["handoffGapRepo"],
    orphanDetectionEnabled: false,
    orphanRadarRepo: null,
    pathGraphSnapshotRepo: {
      findLatest: vi.fn(async () => null),
      create: vi.fn(),
      findHistory: vi.fn(async () => []),
      deleteOlderThan: vi.fn(async () => undefined)
    } as unknown as GardenRuntimeInput["pathGraphSnapshotRepo"],
    pathRelationRepo: {
      findActive: vi.fn(async () => []),
      findByAnchors: vi.fn(async () => [])
    } as unknown as GardenRuntimeInput["pathRelationRepo"],
    strongRefService: {
      isProtected: vi.fn(async () => false)
    } as unknown as GardenRuntimeInput["strongRefService"],
    workspaceRepo: {
      list: vi.fn(async () => workspaceIds.map((workspace_id) => ({ workspace_id })))
    } as unknown as GardenRuntimeInput["workspaceRepo"],
    enrichPendingRepo: options.enrichPendingRepo as unknown as NonNullable<
      GardenRuntimeInput["enrichPendingRepo"]
    >,
    enrichMemoryLookup: { findById: options.findById },
    ...(options.replaySignalRefs === undefined
      ? {}
      : {
          enrichSourceSignalLookup: {
            getById: options.sourceSignalLookup ?? (async (signalId: string) => buildSignal(signalId))
          },
          enrichSignalRefReplayPort: {
            replaySignalRefs: options.replaySignalRefs
          }
        }),
    ...(options.edgeProposalReconcile === undefined
      ? {}
      : { edgeProposalReconcile: options.edgeProposalReconcile }),
    ...(options.omitEnrichmentServices === true
      ? {}
      : {
          enrichEdgeProducerPort: {
            produceForNewMemory: options.produceForNewMemory ?? (async () => undefined)
          },
          ...(options.detectAndLinkConflicts === undefined
            ? {}
            : { enrichConflictDetectionPort: { detectAndLinkConflicts: options.detectAndLinkConflicts } })
        })
  };
}

export function createGardenDataPorts(
  overrides: Partial<GardenRuntimeInput["gardenDataPorts"]> = {}
): GardenRuntimeInput["gardenDataPorts"] {
  return {
    evidenceCheckPort: overrides.evidenceCheckPort ?? { findMemoriesWithStaleEvidence: vi.fn(async () => []) },
    pointerHealthPort: { findBrokenPointers: vi.fn(async () => []) },
    greenMaintenancePort: {
      findExpiringGreenStatuses: vi.fn(async () => []),
      renewGreenPassiveStable: vi.fn(async () => undefined),
      requestActiveVerification: vi.fn(async () => undefined),
      revokeGreen: vi.fn(() => ({ affected: 0 })),
      ...(overrides.greenMaintenancePort ?? {})
    },
    bootstrappingPort: {
      assessColdStart: vi.fn(async () => ({
        is_cold_start: false,
        memory_count: 10,
        claim_count: 5
      })),
      generateDraftCandidates: vi.fn(async () => []),
      findHighFrequencyPatterns: vi.fn(async () => []),
      createSynthesisCandidate: vi.fn(async () => ({ candidate_id: "candidate-1" })),
      hasPendingSynthesisCandidate: vi.fn(async () => false)
    },
    tieringPort: {
      findHotDemotionCandidates: vi.fn(async () => []),
      demoteToWarm: vi.fn(async () => undefined)
    },
    dormantDemotionPort: {
      findLowActivityActiveMemories: vi.fn(async () => []),
      setLifecycleDormant: vi.fn(async () => "skipped" as const),
      ...(overrides.dormantDemotionPort ?? {})
    },
    mergePort: {
      findMergeCandidates: vi.fn(async () => []),
      hasPendingMergeProposal: vi.fn(async () => false),
      createMergeProposal: vi.fn(async () => ({ proposal_id: "proposal-1" })),
      findTemplateClusters: vi.fn(async () => []),
      hasPendingTemplateProposal: vi.fn(async () => false),
      createTemplateCandidate: vi.fn(async () => ({ candidate_id: "template-1" }))
    },
    neighborPort: { findSubjectNeighbors: vi.fn(async () => []) },
    compressionPort: {
      findCompressiblePaths: vi.fn(async () => []),
      createCompressionCandidate: vi.fn(async () => ({ candidate_id: "compression-1" }))
    },
    synthesisPort: {
      findSynthesisCandidateClusters: vi.fn(async () => []),
      hasPendingSynthesisForSubject: vi.fn(async () => false),
      createSynthesisReviewCandidate: vi.fn(async () => ({ candidate_id: "synthesis-1" }))
    }
  } as GardenRuntimeInput["gardenDataPorts"];
}
