import { afterEach, describe, expect, it, vi } from "vitest";
import {
  StorageTier,
  type EventLogEntry,
  type KarmaEvent,
  type MemoryEntry,
  type RecallPolicy
} from "@do-soul/alaya-protocol";
import {
  initDatabase,
  SqliteMemoryEntryRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import {
  RunMode,
  RunState,
  WorkspaceKind,
  WorkspaceState
} from "@do-soul/alaya-protocol";
import { DynamicsService, type DynamicsServiceDependencies } from "../../dynamics/dynamics-service.js";
import { buildRecallFusionDetails } from "../../recall/delivery/fusion-delivery-scoring.js";
import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";
import { buildEvidenceSupportVectors } from "../../recall/supplements/supplementary-data.js";
import { computeIntegratedFloodScore } from "../../recall/scoring/integrated-flood-scoring.js";
import { RECALL_FUSION_DEFAULT_WEIGHTS } from "../../recall/delivery/fusion-delivery-streams.js";
import { resolveConformantEvidenceBeta } from "../../recall/scoring/conformant-fusion-scoring.js";
import { resolvePolicy } from "../../recall/runtime/orchestration.js";
import { matchesPrecomputedRankFilter } from "../../recall/runtime/recall-service-helpers.js";
import type {
  PathInflowEdge,
  RecallFusionBreakdown,
  RecallSupplementaryData
} from "../../recall/runtime/recall-service-types.js";
import { createKarmaEvent, createMemoryEntry } from "../dynamics/karma-fixtures.js";
import { createMemoryEntry as createRecallFixtureEntry } from "./recall-service-test-fixtures.js";

const WS = "workspace-1";
const RUN = "run-regression";
const NOW = "2026-03-20T10:20:30.000Z";
const QUERY = "how does staging rotate database credentials";

const MANAGED_ENV = [
  "ALAYA_RECALL_FACET_SLICE",
  "ALAYA_RECALL_CONF_EVIDENCE_BETA"
] as const;

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
  for (const name of MANAGED_ENV) {
    delete process.env[name];
  }
});

function createRealStorage(): SqliteMemoryEntryRepo {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  new SqliteWorkspaceRepo(database).create({
    workspace_id: WS,
    name: "regression workspace",
    root_path: "/tmp/regression",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });
  new SqliteRunRepo(database).create({
    run_id: RUN,
    workspace_id: WS,
    title: "regression run",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });
  return new SqliteMemoryEntryRepo(database);
}

interface CandidateSpec {
  readonly id: string;
  readonly lexical?: number;
  readonly evidenceSupports?: readonly number[];
  readonly eventStart?: string;
  readonly eventEnd?: string;
  readonly manifestation?: MemoryEntry["manifestation_state"];
  readonly confidence?: number;
}

function objectId(index: number): string {
  return `00000000-0000-4000-8000-0000000000${index.toString(16).padStart(2, "0")}`;
}

function keyOf(id: string): string {
  return `workspace_local:memory_entry:${id}`;
}

async function seedEntries(
  repo: SqliteMemoryEntryRepo,
  specs: readonly CandidateSpec[]
): Promise<Map<string, MemoryEntry>> {
  for (const spec of specs) {
    await repo.create(
      createRecallFixtureEntry({
        object_id: spec.id,
        content: "neutral memory content for regression recall",
        evidence_refs: spec.evidenceSupports?.map((_support, index) => `${spec.id}-ev-${index}`) ?? [],
        surface_id: null,
        activation_score: 0.4,
        ...(spec.eventStart !== undefined ? { event_time_start: spec.eventStart } : {}),
        ...(spec.eventEnd !== undefined ? { event_time_end: spec.eventEnd } : {}),
        ...(spec.manifestation !== undefined ? { manifestation_state: spec.manifestation } : {}),
        ...(spec.confidence !== undefined ? { confidence: spec.confidence } : {})
      }) as MemoryEntry
    );
  }
  const stored = await repo.findByWorkspaceId(WS);
  return new Map(stored.map((entry) => [entry.object_id, entry]));
}

function supplementary(
  query: string,
  specs: readonly CandidateSpec[],
  entries: readonly MemoryEntry[],
  extras: Partial<RecallSupplementaryData> = {}
): RecallSupplementaryData {
  const record = (pick: (spec: CandidateSpec) => number | undefined): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const spec of specs) {
      const value = pick(spec);
      if (value !== undefined) {
        out[spec.id] = value;
      }
    }
    return out;
  };
  return {
    queryProbes: compileRecallQueryProbes(query),
    ftsRanks: record((s) => s.lexical),
    trigramFtsRanks: {},
    synthesisFtsRanks: {},
    evidenceFtsRanks: {},
    evidenceFtsRanksPerRef: {},
    sourceProximityScores: {},
    sourceCohortKeys: {},
    structuralScores: {},
    graphExpansionScores: {},
    entitySeedScores: {},
    pathExpansionScores: {},
    pathSuppressionScores: {},
    embeddingSimilarityScores: {},
    graphSupportCounts: {},
    evidenceSupportVectorsByMemoryId: buildEvidenceSupportVectors(entries),
    budgetPenaltyFactor: 0,
    plasticityFactors: {},
    graphAndPathColdScore: 0,
    recallsEdgeCount: 0,
    weightTransferAmount: 0,
    evidenceGistsByMemoryId: {},
    governanceCeilingByMemoryId: {},
    ...extras
  };
}

async function runFusion(
  specs: readonly CandidateSpec[],
  extras: Partial<RecallSupplementaryData> = {}
): Promise<ReadonlyMap<string, RecallFusionBreakdown>> {
  const repo = createRealStorage();
  const byId = await seedEntries(repo, specs);
  const entries = specs.map((spec) => byId.get(spec.id)!);
  return buildRecallFusionDetails({
    candidates: specs.map((spec) => ({
      entry: byId.get(spec.id)!,
      effectiveScore: 0,
      effectiveFactors: { activation: 0, relevance: 0 },
      structuralScore: 0
    })),
    policy: {} as RecallPolicy,
    supplementaryData: supplementary(QUERY, specs, entries, extras),
    nowIso: NOW
  });
}

function createDecayHarness(getNow: () => string): {
  readonly service: DynamicsService;
  readonly entriesById: Map<string, MemoryEntry>;
  readonly appendedEvents: EventLogEntry[];
} {
  const entriesById = new Map<string, MemoryEntry>();
  const appendedEvents: EventLogEntry[] = [];
  const karmaEvents: KarmaEvent[] = [];

  const dependencies: DynamicsServiceDependencies = {
    now: getNow,
    memoryRepo: {
      findById: vi.fn(async (objectId: string) => {
        const found = entriesById.get(objectId);
        return found === undefined ? null : Object.freeze({ ...found });
      }),
      findByWorkspaceId: vi.fn(async (workspaceId: string, tier?: StorageTier) =>
        [...entriesById.values()]
          .filter(
            (entry) =>
              entry.workspace_id === workspaceId && (tier === undefined || entry.storage_tier === tier)
          )
          .map((entry) => Object.freeze({ ...entry }))
      ),
      updateDynamics: vi.fn(async (objectId, fields, updatedAt) => {
        const existing = entriesById.get(objectId);
        if (existing === undefined) {
          throw new Error(`missing entry ${objectId}`);
        }
        const updated: MemoryEntry = {
          ...existing,
          activation_score: fields.activation_score,
          retention_score: fields.retention_score,
          manifestation_state: fields.manifestation_state,
          retention_state: fields.retention_state ?? existing.retention_state,
          updated_at: updatedAt
        };
        entriesById.set(objectId, updated);
        return Object.freeze({ ...updated });
      })
    },
    karmaEventRepo: {
      create: vi.fn(async (event) => {
        karmaEvents.push(event);
        return Object.freeze({ ...event });
      }),
      sumByObjectId: vi.fn(async (objectId: string) =>
        karmaEvents.filter((event) => event.object_id === objectId).reduce((sum, event) => sum + event.amount, 0)
      ),
      sumByObjectIds: vi.fn(async (objectIds: readonly string[]) => {
        const totals: Record<string, number> = {};
        for (const objectId of objectIds) {
          totals[objectId] = karmaEvents
            .filter((event) => event.object_id === objectId)
            .reduce((sum, event) => sum + event.amount, 0);
        }
        return Object.freeze(totals);
      }),
      findByObjectId: vi.fn(async (objectId: string) =>
        karmaEvents.filter((event) => event.object_id === objectId).map((event) => Object.freeze({ ...event }))
      )
    },
    eventLogRepo: {
      append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => {
        const created: EventLogEntry = {
          event_id: `event-${appendedEvents.length + 1}`,
          created_at: getNow(),
          revision: 0,
          ...entry
        };
        appendedEvents.push(created);
        return created;
      }),
      queryByEntity: vi.fn(async () => [])
    },
    runtimeNotifier: {
      notifyEntry: vi.fn(async () => {})
    }
  };

  return { service: new DynamicsService(dependencies), entriesById, appendedEvents };
}

describe("formula and lifecycle regression net", () => {
  it("protects embedding policy parity: core default and resolved decorator fusion weight is 12", () => {
    expect(RECALL_FUSION_DEFAULT_WEIGHTS.embedding_similarity).toBe(12);
    const resolved = resolvePolicy({
      strategy: "chat",
      taskSurfaceRef: "00000000-0000-4000-8000-000000000099",
      policyOverride: {
        runtime_id: "00000000-0000-4000-8000-000000000001",
        object_kind: "recall_policy",
        task_surface_ref: "00000000-0000-4000-8000-000000000099",
        expires_at: null,
        derived_from: null,
        retention_policy: "session_only",
        coarse_filter: {
          deterministic_match: {
            scope_filter: null,
            dimension_filter: null,
            domain_tag_filter: null
          },
          precomputed_rank: { max_candidates: 100, min_activation_score: null },
          semantic_supplement: { enabled: true, max_supplement: 100, embedding_enabled: false }
        },
        fine_assessment: {
          budgets: { max_total_tokens: 2000, max_entries: 10, per_dimension_limits: null },
          conflict_awareness: true
        }
      } as RecallPolicy,
      buildDefaultPolicy: () =>
        ({
          runtime_id: "00000000-0000-4000-8000-000000000088",
          object_kind: "recall_policy",
          task_surface_ref: "00000000-0000-4000-8000-000000000099",
          expires_at: null,
          derived_from: null,
          retention_policy: "session_only",
          coarse_filter: {
            deterministic_match: {
              scope_filter: null,
              dimension_filter: null,
              domain_tag_filter: null
            },
            precomputed_rank: { max_candidates: 100, min_activation_score: null },
            semantic_supplement: { enabled: true, max_supplement: 100, embedding_enabled: false }
          },
          fine_assessment: {
            budgets: { max_total_tokens: 2000, max_entries: 10, per_dimension_limits: null },
            conflict_awareness: true
          }
        }) as RecallPolicy,
      defaultPolicyDecorator: (policy) => ({
        ...policy,
        scoring_weight_overrides: {
          fusion_weights: {
            embedding_similarity: 12
          }
        }
      })
    });
    expect(resolved.scoring_weight_overrides?.fusion_weights?.embedding_similarity).toBe(12);
  });

  it("protects cold-start identity: no verified fuel means fused score equals R_obj", async () => {
    const candidate = (await runFusion([{ id: objectId(1), lexical: 1 }])).get(keyOf(objectId(1)))!;
    expect(candidate.flood_potential?.fuel_verified).toBe(false);
    expect(candidate.flood_potential?.Flood).toBe(0);
    expect(candidate.fused_score).toBeCloseTo(candidate.per_axis_contribution!.object, 12);
  });

  it("protects fuel gating: inactive reasons name missing slice, path, and evidence fuel", () => {
    process.env.ALAYA_RECALL_FACET_SLICE = "1";
    const entry = createRecallFixtureEntry({
      object_id: "11111111-1111-4111-8111-111111111111",
      facet_tags: []
    });
    const cold = computeIntegratedFloodScore({
      entry,
      axisInputs: { R_obj: 0.4, A_path: 0.3, B_evidence: 0.2 },
      supplementaryData: supplementary(QUERY, [], [entry], {
        querySoughtFacets: ["location_place"]
      })
    });
    expect(cold.diagnostics.slice_status).toBe("inactive:no_fuel");
    expect(cold.diagnostics.path_status).toBe("inactive:pass_through");
    expect(cold.diagnostics.evidence_status).toBe("inactive:pass_through");
    expect(cold.diagnostics.fuel_verified).toBe(false);

    const targetId = "22222222-2222-4222-8222-222222222222";
    const target = createRecallFixtureEntry({ object_id: targetId, evidence_refs: ["ev-path"] });
    const inflow: Readonly<Record<string, readonly PathInflowEdge[]>> = {
      [targetId]: [{ seedObjectId: entry.object_id, weight: 1 }]
    };
    const warm = computeIntegratedFloodScore({
      entry: target,
      axisInputs: { R_obj: 0.1, A_path: 0.5, B_evidence: 1 },
      supplementaryData: supplementary(QUERY, [], [entry, target], { pathInflowByTarget: inflow })
    });
    expect(warm.diagnostics.path_status).toBe("active");
    expect(warm.diagnostics.evidence_status).toBe("active");
    expect(warm.diagnostics.fuel_verified).toBe(true);
  });

  it("protects formula assembly: evidence direct multiplier stays disabled until beta support fuel", () => {
    const entry = createRecallFixtureEntry({
      object_id: "33333333-3333-4333-8333-333333333333",
      evidence_refs: ["ev-a"]
    });
    const seed = createRecallFixtureEntry({
      object_id: "44444444-4444-4444-8444-444444444444"
    });
    const vectors = {
      [entry.object_id]: [{ source_kind: "evidence_ref" as const, source_id: "ev-a", support: 0.8 }]
    };
    const inflow: Readonly<Record<string, readonly PathInflowEdge[]>> = {
      [entry.object_id]: [{ seedObjectId: seed.object_id, weight: 1 }]
    };
    const result = computeIntegratedFloodScore({
      entry,
      axisInputs: { R_obj: 0.25, A_path: 0, B_evidence: 0.8 },
      supplementaryData: supplementary(QUERY, [], [entry], {
        evidenceSupportVectorsByMemoryId: vectors
      })
    });
    expect(result.diagnostics.fuel_verified).toBe(false);
    expect(result.score).toBeCloseTo(0.25, 12);

    const withPathFuel = computeIntegratedFloodScore({
      entry,
      axisInputs: { R_obj: 0.25, A_path: 0.5, B_evidence: 0.8 },
      supplementaryData: supplementary(QUERY, [], [seed, entry], {
        evidenceSupportVectorsByMemoryId: vectors,
        pathInflowByTarget: inflow
      })
    });
    expect(resolveConformantEvidenceBeta()).toBe(0);
    expect(withPathFuel.diagnostics.e_direct_status).toBe("inactive:beta_disabled");
    expect(withPathFuel.diagnostics.beta).toBe(0);
    expect(withPathFuel.score).toBeCloseTo(withPathFuel.diagnostics.final_score, 12);
    const withoutMultiplier =
      withPathFuel.diagnostics.R_obj +
      withPathFuel.diagnostics.lambda *
        withPathFuel.diagnostics.omega *
        withPathFuel.diagnostics.Flood *
        (1 - withPathFuel.diagnostics.R_obj);
    expect(withPathFuel.score).toBeCloseTo(withoutMultiplier, 9);
    expect(withPathFuel.score).not.toBeCloseTo(withoutMultiplier * (1 + 0.8), 6);
  });

  it("protects temporal/control placement: integrated flood target path does not add +T/+C", async () => {
    const specs: readonly CandidateSpec[] = [
      {
        id: objectId(1),
        lexical: 1,
        eventStart: "2020-01-01T00:00:00.000Z",
        eventEnd: "2020-12-31T23:59:59.000Z",
        manifestation: "full_eligible",
        confidence: 0.95
      },
      {
        id: objectId(2),
        lexical: 1,
        eventStart: "2025-06-01T00:00:00.000Z",
        eventEnd: "2025-06-30T23:59:59.000Z",
        manifestation: "hint",
        confidence: 0.2
      }
    ];
    const fusion = await runFusion(specs);
    for (const spec of specs) {
      const row = fusion.get(keyOf(spec.id))!;
      const axes = row.per_axis_contribution!;
      const flood = row.flood_potential!;
      expect(flood.fuel_verified).toBe(false);
      expect(row.fused_score).toBeCloseTo(flood.R_obj, 12);
      expect(row.fused_score).toBeCloseTo(flood.final_score, 12);
      expect(axes.temporal).toBeGreaterThanOrEqual(0);
      expect(axes.control).toBeGreaterThan(0);
      expect(row.fused_score).not.toBeCloseTo(flood.R_obj + axes.temporal + axes.control, 6);
    }
    const early = fusion.get(keyOf(objectId(1)))!.per_axis_contribution!;
    const late = fusion.get(keyOf(objectId(2)))!.per_axis_contribution!;
    expect(early.temporal).not.toBeCloseTo(late.temporal, 3);
    expect(early.control).not.toBeCloseTo(late.control, 3);
  });

  it("protects lifecycle feedback: retention decay lowers activation and recall precomputed rank eligibility", async () => {
    let nowIso = "2025-06-01T00:00:00.000Z";
    const createdAt = "2025-01-01T00:00:00.000Z";
    const { service, entriesById, appendedEvents } = createDecayHarness(() => nowIso);

    entriesById.set(
      "memory-decay",
      createMemoryEntry({
        object_id: "memory-decay",
        created_at: createdAt,
        updated_at: createdAt,
        storage_tier: StorageTier.HOT,
        last_used_at: "2025-06-01T00:00:00.000Z",
        last_hit_at: "2025-06-01T00:00:00.000Z"
      })
    );

    await service.processKarmaEvent(
      createKarmaEvent({
        kind: "reuse_gain",
        object_id: "memory-decay",
        created_at: nowIso
      })
    );

    const beforeActivation = entriesById.get("memory-decay")!.activation_score ?? 0;
    const coarseFilter = {
      precomputed_rank: { min_activation_score: beforeActivation - 0.01 }
    } as RecallPolicy["coarse_filter"];
    expect(matchesPrecomputedRankFilter(entriesById.get("memory-decay")!, coarseFilter)).toBe(true);

    nowIso = "2026-07-01T00:00:00.000Z";
    const result = await service.scanRetentionDecay("workspace-1");
    expect(result.updated_count).toBe(1);
    const updated = entriesById.get("memory-decay")!;
    expect(updated.activation_score).toBeLessThan(beforeActivation);
    expect(matchesPrecomputedRankFilter(updated, coarseFilter)).toBe(false);
    expect(appendedEvents.some((entry) => entry.event_type === "soul.memory.retention_updated")).toBe(
      true
    );
  });
});
