import { access, mkdtemp, rm, writeFile } from "node:fs/promises";

import { tmpdir } from "node:os";

import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  initDatabase,
  SqliteGardenTaskRepo,
  SqliteSignalRepo,
  type GardenTaskEventPublisherPort
} from "@do-soul/alaya-storage";

import {
  GardenRole,
  GardenTaskKind,
  SignalSource,
  isPathRecallEligible,
  mapRelationKindToGraphEdgeType,
  type GardenClaimTaskResponse
} from "@do-soul/alaya-protocol";

import {
  BENCH_DAEMON_MANAGED_ENV_KEYS,
  startBenchDaemon,
  type BenchDaemonHandle,
  type BenchSignalSeedInput
} from "../../../harness/daemon.js";

import {
  closeBenchDaemonResources,
  optimizeBenchDb,
  resolveBenchReviewerCredentials
} from "../../../harness/daemon/daemon-support.js";

import { BENCH_CO_RECALL_WARMUP_PAIR_CAP } from "../../../harness/embedding/co-recall-warmup.js";

import {
  BenchRecallDiagnosticsSchema,
  type BenchRecallDiagnostics
} from "../../../harness/recall/recall-diagnostics-schema.js";

import {
  createCompileSeedRunner,
  type CompileSeedExtractionConfig
} from "../../../longmemeval/compile-seed.js";

const handles: BenchDaemonHandle[] = [];

const tmpRoots: string[] = [];

type BenchDatabase = ReturnType<typeof initDatabase>;

interface DerivesFromPathRow {
  readonly relation_kind: string;
  readonly source_object_id: string;
  readonly target_object_id: string;
  readonly recall_bias: number;
}

// invariant: signal-ref edges fold into governed path_relations rows.
// These helpers read the path-candidate side (derives_from for
// source_memory_refs) and confirm the old edge_proposals sink stays empty.
function readDerivesFromPathRelation(
  db: BenchDatabase,
  sourceObjectId: string,
  targetObjectId: string
): DerivesFromPathRow | undefined {
  return db.connection
    .prepare(
      `SELECT json_extract(constitution_json, '$.relation_kind')        AS relation_kind,
              json_extract(anchors_json, '$.source_anchor.object_id')   AS source_object_id,
              json_extract(anchors_json, '$.target_anchor.object_id')   AS target_object_id,
              json_extract(effect_vector_json, '$.recall_bias')         AS recall_bias
         FROM path_relations
        WHERE json_extract(anchors_json, '$.source_anchor.object_id') = ?
          AND json_extract(anchors_json, '$.target_anchor.object_id') = ?
          AND json_extract(constitution_json, '$.relation_kind') = 'derives_from'`
    )
    .get(sourceObjectId, targetObjectId) as DerivesFromPathRow | undefined;
}

interface CoRecalledPathRow {
  readonly source_object_id: string;
  readonly target_object_id: string;
  readonly recall_bias: number;
  readonly lifecycle_status: string;
  readonly governance_class: string;
}

// invariant: read the recalls-tier co_recalled paths the bench co-recall hub
// mints. recall_bias + lifecycle_status are what isPathRecallEligible gates on
// (active lifecycle AND recall_bias > 0), so the test asserts eligibility from
// the durable row, not from a re-import of the predicate.
// see also: packages/protocol/src/soul/path-relation.ts isPathRecallEligible
function readCoRecalledPathRelations(
  db: BenchDatabase,
  workspaceId: string
): readonly CoRecalledPathRow[] {
  return db.connection
    .prepare(
      `SELECT json_extract(anchors_json, '$.source_anchor.object_id')   AS source_object_id,
              json_extract(anchors_json, '$.target_anchor.object_id')   AS target_object_id,
              json_extract(effect_vector_json, '$.recall_bias')         AS recall_bias,
              json_extract(lifecycle_json, '$.status')                  AS lifecycle_status,
              json_extract(legitimacy_json, '$.governance_class')       AS governance_class
         FROM path_relations
        WHERE workspace_id = ?
          AND json_extract(constitution_json, '$.relation_kind') = 'co_recalled'`
    )
    .all(workspaceId) as readonly CoRecalledPathRow[];
}

function edgeProposalCount(
  db: BenchDatabase,
  sourceMemoryId: string,
  targetMemoryId: string
): number {
  const row = db.connection
    .prepare(
      `SELECT COUNT(*) AS n
         FROM edge_proposals
        WHERE source_memory_id = ?
          AND target_memory_id = ?`
    )
    .get(sourceMemoryId, targetMemoryId) as { readonly n: number };
  return row.n;
}

// invariant: re-parse the recall handle's `diagnostics: unknown` field through
// the SAME BenchRecallDiagnosticsSchema the harness already applied internally,
// so the per-candidate admission-plane diagnostics are typed (no `as` cast).
// admission_planes records WHY each candidate entered the recall pool:
// "activation" / "domain_tag_cluster" = structural/content admission,
// "path_expansion" / "graph_expansion" = the unified path plane (direct 1-hop
// vs multi-hop), which exists for a candidate only when a path edge reaches it.
function findCandidateDiagnostic(
  diagnostics: unknown,
  objectId: string
): BenchRecallDiagnostics["candidates"][number] | undefined {
  if (diagnostics === undefined) {
    return undefined;
  }
  const parsed = BenchRecallDiagnosticsSchema.parse(diagnostics);
  return parsed.candidates.find((candidate) => candidate.object_id === objectId);
}

function snapshotManagedEnv(): Record<string, string | undefined> {
  return Object.fromEntries(BENCH_DAEMON_MANAGED_ENV_KEYS.map((key) => [key, process.env[key]]));
}

afterEach(async () => {
  for (const h of handles.splice(0)) {
    await h.shutdown().catch(() => undefined);
  }
  for (const root of tmpRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("BenchDaemon harness — real MCP propose+review chain", () => {

  it(
    "bench seed sourceMemoryRefs stay unasserted without a verified source observation",
    async () => {
      const daemon = await startBenchDaemon({
        workspaceId: "harness-first-class-ref-ws",
        runId: "harness-first-class-ref-run"
      });
      handles.push(daemon);

      const parent = await daemon.proposeMemory(
        "Mira started maintaining the release checklist.",
        "first-class-ref-parent",
        { objectKind: "fact" }
      );
      const child = await daemon.proposeMemory(
        "Mira now updates the release checklist every Friday.",
        "first-class-ref-child",
        {
          objectKind: "fact",
          sourceMemoryRefs: [parent.memoryId]
        }
      );

      const db = initDatabase({ filename: join(daemon.dataDir, "alaya.db") });
      const signalRepo = new SqliteSignalRepo(db);
      const signal = await signalRepo.getById(child.signalId);

      expect(signal?.source_memory_refs).toEqual([parent.memoryId]);
      expect(signal?.raw_payload).not.toHaveProperty("source_memory_refs");
      expect(signal?.source_observation).toBeNull();

      // A caller-supplied reference is preserved, but S4 does not mint a
      // temporal relationship without a daemon-issued source observation.
      const pathRow = readDerivesFromPathRelation(db, child.memoryId, parent.memoryId);
      expect(pathRow).toBeUndefined();
      expect(edgeProposalCount(db, child.memoryId, parent.memoryId)).toBe(0);
    },
    60_000
  );

  it(
    "compile seed sourceMemoryRefs stay unasserted without a verified source observation",
    async () => {
      const daemon = await startBenchDaemon({
        workspaceId: "harness-compile-first-class-ref-ws",
        runId: "harness-compile-first-class-ref-run"
      });
      handles.push(daemon);

      const parent = await daemon.proposeMemory(
        "Nora archived the support rotation note.",
        "compile-first-class-ref-parent",
        { objectKind: "fact" }
      );
      const inputs: readonly BenchSignalSeedInput[] = [
        {
          signalKind: "potential_preference",
          objectKind: "fact",
          confidence: 0.9,
          distilledFact: "Nora now updates the support rotation note weekly.",
          turnContent: "I update the support rotation note every Friday now.",
          matchedText: "support rotation note",
          evidenceRef: "compile-first-class-ref-child",
          turnSeedIndex: 1,
          extractionProvider: "official_api_compile",
          sourceMemoryRefs: [parent.memoryId]
        }
      ];

      const { seeds } = await daemon.proposeMemoriesFromCompileSignals(inputs);
      const child = seeds[0];
      if (child === undefined) {
        throw new Error("compile seed did not materialize a child memory");
      }

      const db = initDatabase({ filename: join(daemon.dataDir, "alaya.db") });
      const signalRepo = new SqliteSignalRepo(db);
      const signal = await signalRepo.getById(child.signalId);

      expect(signal?.source).toBe(SignalSource.GARDEN_COMPILE);
      expect(signal?.source_memory_refs).toEqual([parent.memoryId]);
      expect(signal?.raw_payload).not.toHaveProperty("source_memory_refs");
      expect(signal?.source_observation).toBeNull();

      // A compile fixture without a daemon-issued completion receipt cannot
      // create a temporal relationship from an unverified source reference.
      const pathRow = readDerivesFromPathRelation(db, child.memoryId, parent.memoryId);
      expect(pathRow).toBeUndefined();
      expect(edgeProposalCount(db, child.memoryId, parent.memoryId)).toBe(0);
    },
    60_000
  );

  it(
    "accrueSessionCoRecall EARNS sparse recall-eligible co_recalled paths through the production counter gate",
    async () => {
      const workspaceId = "harness-co-recall-ws";
      const daemon = await startBenchDaemon({
        workspaceId,
        runId: "harness-co-recall-run"
      });
      handles.push(daemon);

      // Seed five same-session members in seed order. Pair selection is
      // positional (adjacent in seed order); NO gold/answer knowledge is
      // consulted (the test never marks any member as the answer).
      const seeded = [];
      for (let i = 0; i < 5; i += 1) {
        seeded.push(
          await daemon.proposeMemory(
            `Session member ${i}: ledger detail number ${i}.`,
            `co-recall-m${i}`,
            { objectKind: "fact" }
          )
        );
      }
      const members = seeded.map((s) => s.memoryId);

      const summary = await daemon.accrueSessionCoRecall(members);

      // EARNED: pairs reached the production co_usage_threshold and minted.
      // SPARSE: at most BENCH_CO_RECALL_WARMUP_PAIR_CAP (3) pairs are observed,
      // FAR below a same-session hub's N-1=4 spokes or a clique's C(5,2)=10
      // edges. This is the sparseness contract.
      expect(summary.pairsObserved).toBe(BENCH_CO_RECALL_WARMUP_PAIR_CAP);
      expect(summary.minted).toBe(BENCH_CO_RECALL_WARMUP_PAIR_CAP);
      expect(summary.belowThreshold).toBe(0);
      expect(summary.minted).toBeLessThan(members.length - 1);

      const db = initDatabase({ filename: join(daemon.dataDir, "alaya.db") });
      const coRecalled = readCoRecalledPathRelations(db, workspaceId);

      // NONZERO and SPARSE recalls-tier co_recalled paths earned (one per
      // settled pair), not a saturated hub.
      expect(coRecalled.length).toBe(BENCH_CO_RECALL_WARMUP_PAIR_CAP);
      expect(coRecalled.length).toBeLessThan(members.length - 1);

      // The earned edges are the adjacent member pairs (chain), normalized to
      // (low, high) to match the production counter key.
      const sortedPair = (a: string, b: string): [string, string] =>
        a < b ? [a, b] : [b, a];
      const expectedPairs = new Set(
        [0, 1, 2].map((i) => {
          const [low, high] = sortedPair(members[i]!, members[i + 1]!);
          return `${low}\0${high}`;
        })
      );
      const earnedPairs = new Set(
        coRecalled.map((row) => `${row.source_object_id}\0${row.target_object_id}`)
      );
      expect(earnedPairs).toEqual(expectedPairs);

      for (const row of coRecalled) {
        // Recall-eligibility at the born band: active lifecycle AND
        // recall_bias > 0 — no plasticity reinforcement required.
        expect(row.recall_bias).toBeGreaterThan(0);
        expect(
          isPathRecallEligible({
            lifecycle: { status: row.lifecycle_status as "active" },
            effect_vector: { recall_bias: row.recall_bias }
          } as Parameters<typeof isPathRecallEligible>[0])
        ).toBe(true);
        // invariant: earned co_recalled is born at attention_only (the
        // auto-build associative band), gating only the suppression lane.
        expect(row.governance_class).toBe("attention_only");
      }

      // graph health groups by raw relation_kind; the runner folds each kind
      // into its graph edge_type (mapRelationKindToGraphEdgeType) before
      // summing recalls_edge_count. co_recalled folds into the "recalls" tier,
      // so recalls_edge_count > 0.
      // see also: apps/bench-runner/src/longmemeval/runner.ts
      //   readLongMemEvalReportSideEffectSnapshot
      const status =
        await daemon.runtime.services.graphHealthService.getStatus(workspaceId);
      let recallsCount = 0;
      for (const [kind, count] of Object.entries(status.path_relations_by_kind)) {
        if (mapRelationKindToGraphEdgeType(kind) === "recalls") {
          recallsCount += count;
        }
      }
      expect(recallsCount).toBe(BENCH_CO_RECALL_WARMUP_PAIR_CAP);
    },
    60_000
  );
});
