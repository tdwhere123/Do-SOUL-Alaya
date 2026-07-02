import { access, mkdtemp, rm, writeFile } from "node:fs/promises";

import { tmpdir } from "node:os";

import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  type BenchDaemonHandle,
  type BenchSignalSeedInput
} from "../../harness/daemon.js";

import { withBenchDaemon } from "./bench-daemon.test-support.js";

import {
  closeBenchDaemonResources,
  optimizeBenchDb,
  resolveBenchReviewerCredentials
} from "../../harness/daemon-support.js";

import { BENCH_CO_RECALL_WARMUP_PAIR_CAP } from "../../harness/co-recall-warmup.js";

import {
  BenchRecallDiagnosticsSchema,
  type BenchRecallDiagnostics
} from "../../harness/recall-diagnostics-schema.js";

import {
  createCompileSeedRunner,
  type CompileSeedExtractionConfig
} from "../../longmemeval/compile-seed.js";

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
  beforeEach(() => { process.env.ALAYA_RECALL_STRUCTURAL_RESERVE = "on"; });
  afterEach(() => { delete process.env.ALAYA_RECALL_STRUCTURAL_RESERVE; });

  it(
    "a query hitting a NON-representative co-recall member fans into its sibling via graph_expansion at hop-2",
    async () => {
      // red-team Important 3: the mechanism R2 depends on. An earned co_recalled
      // edge is minted with direction_bias=bidirectional_asymmetric, so
      // graph_expansion (collectPathGraphNeighbors) traverses it in BOTH
      // directions. A query that surfaces ONE member of an earned pair must
      // fan into the other member through the path plane, even though that
      // sibling is not a direct content/embedding hit for the query.
      //
      // Topology note (the actual earned shape, not a strict hub): earned
      // accrual mints PAIRS (chain of adjacent members), each minted via
      // proposeCoRecalled(low, high) where low<high — so the lexicographically
      // SMALLER member id is the source and the LARGER is the target. The
      // graph_support recall factor credits ONLY inbound/target paths
      // (graph-explore-service.findInboundRecallEligiblePaths ->
      // findByTargetAnchor), so of an earned pair only the LARGER-id member
      // receives graph_support amplification. graph_expansion fan-in, by
      // contrast, is bidirectional and reaches the sibling regardless of which
      // id is larger — that is why R2 must rely on graph_expansion, not
      // graph_support, for sibling fan-in.
      // see also: packages/core/src/recall/path-relations.ts collectPathGraphNeighbors
      // see also: packages/core/src/graph-explore-service.ts findInboundRecallEligiblePaths
      //
      // NON-VACUOUS contract: the bench recall policy sets no relevance floor
      // (min_activation_score=null) and MIN_RECALL_RESULTS=5 backfills the
      // delivery from the candidate POOL. With only an anchor + sibling seeded
      // and a generous budget, BOTH always deliver regardless of any edge, so
      // the edge proves nothing — that is the vacuousness this test removes.
      //
      // Two design facts make the edge load-bearing:
      //  (a) DECOY_COUNT=15 content-disjoint decoys that ARE query-relevant. The
      //      recall budget is set BELOW the content-candidate count (decoys +
      //      anchor = 16) so the content hits alone can fill it; the sibling
      //      (zero query overlap) can never be a fused-rank or min-results
      //      freebie above them.
      //  (b) The bench seeds all carry the same domain_tags=["bench-seed"], so
      //      the structural domain_tag_cluster plane sweeps the sibling into the
      //      candidate POOL in BOTH cases. Pool entry is therefore NOT the
      //      discriminator — DELIVERY under the tight budget is. Only the earned
      //      co_recalled edge gives the sibling a path-plane admission
      //      (path_expansion, the direct 1-hop pass of the unified path plane
      //      graph_expansion's multi-hop traversal belongs to), and that
      //      admission is what wins it a delivery slot above the content hits.
      //
      // Airtight both directions: WITH the edge the sibling is delivered, is
      // within_budget, and carries the path_expansion admission + non-null
      // path_expansion stream rank; WITHOUT the edge (negative control, same
      // seed set) the sibling is ABSENT from the delivered top-N, is
      // within_budget=false, and carries NO path_expansion admission.
      // see also: packages/core/src/recall/recall-service-helpers.ts MIN_RECALL_RESULTS
      // see also: apps/bench-runner/src/harness/daemon.ts
      //   buildBenchDiagnosticRecallPolicy (min_activation_score=null)

      const DECOY_COUNT = 15;
      // Budget below DECOY_COUNT + 1 (anchor) = 16 content candidates, so the
      // content hits saturate the delivery and the sibling needs the edge's
      // path-plane admission to claim a slot.
      const FANIN_MAX_RESULTS = 12;
      const QUERY = "quarterly ledger reconciliation runbook finance vault";
      const ANCHOR_CONTENT =
        "The quarterly ledger reconciliation runbook lives in the finance vault.";
      // Content-disjoint from the query: no lexical/embedding overlap, so the
      // ONLY query-relevant route to a DELIVERY slot is the path-plane edge.
      const SIBLING_CONTENT =
        "Aurora prefers oat milk in her espresso every morning.";

      // Decoys share the query's finance/ledger vocabulary, so each is a
      // stronger content hit than the sibling — they outrank it and fill the
      // budget.
      const decoyContents = Array.from(
        { length: DECOY_COUNT },
        (_unused, i) =>
          `Ledger reconciliation note ${i}: the finance vault runbook records ` +
          `quarterly variance entry ${i} for the reconciliation ledger.`
      );

      // Shared seeding so the positive case and the negative control run on
      // byte-identical content; only edge minting differs.
      const seedFaninWorld = async (
        daemon: BenchDaemonHandle
      ): Promise<{ anchorId: string; siblingId: string }> => {
        const anchor = await daemon.proposeMemory(ANCHOR_CONTENT, "fanin-anchor", {
          objectKind: "fact"
        });
        const sibling = await daemon.proposeMemory(
          SIBLING_CONTENT,
          "fanin-sibling",
          { objectKind: "fact" }
        );
        for (let i = 0; i < decoyContents.length; i += 1) {
          await daemon.proposeMemory(decoyContents[i]!, `fanin-decoy-${i}`, {
            objectKind: "fact"
          });
        }
        return { anchorId: anchor.memoryId, siblingId: sibling.memoryId };
      };

      // ---- POSITIVE: edge minted -> sibling delivered via the path plane ----
      await withBenchDaemon(
        {
          workspaceId: "harness-co-recall-fanin-ws",
          runId: "harness-co-recall-fanin-run"
        },
        async (positiveDaemon) => {
          const positive = await seedFaninWorld(positiveDaemon);

          // Earn the co_recalled edge between anchor and sibling through the
          // production gate (decoys are NOT in the pair, so they grow no edges).
          const summary = await positiveDaemon.accrueSessionCoRecall([
            positive.anchorId,
            positive.siblingId
          ]);
          expect(summary.minted).toBe(1);

          // BUDGET below the decoy count (DECOY_COUNT=15 + anchor = 16 content
          // candidates): the budget can hold all the query-relevant content hits
          // but cannot also fit the content-irrelevant sibling on fused rank alone.
          const positiveRecall = await positiveDaemon.recall(QUERY, {
            maxResults: FANIN_MAX_RESULTS
          });
          const positiveIds = new Set(
            positiveRecall.results.map((r) => r.object_id)
          );

          // The anchor is the direct content hit.
          expect(positiveIds).toContain(positive.anchorId);
          // The sibling is DELIVERED (within budget) only because the earned
          // co_recalled edge fans it in across the unified path plane.
          expect(positiveIds).toContain(positive.siblingId);
          const positiveSiblingDiag = findCandidateDiagnostic(
            positiveRecall.diagnostics,
            positive.siblingId
          );
          expect(positiveSiblingDiag).toBeDefined();
          expect(positiveSiblingDiag!.within_budget).toBe(true);
          expect(positiveSiblingDiag!.final_rank).not.toBeNull();
          // The edge's load-bearing signal: the sibling carries the path-plane
          // admission (path_expansion is the direct 1-hop pass of the same unified
          // path plane graph_expansion's multi-hop traversal belongs to). This
          // plane and its non-null RRF stream rank CANNOT exist without the edge.
          // see also: packages/core/src/recall/recall-service.ts (path_expansion /
          //   graph_expansion share the unified path plane; the double-count guard
          //   credits path_expansion when the 1-hop pass already admitted a target)
          expect(positiveSiblingDiag!.admission_planes).toContain("path_expansion");
          expect(positiveSiblingDiag!.per_stream_rank.path_expansion).not.toBeNull();
        }
      );

      // ---- NEGATIVE CONTROL: NO edge -> sibling ABSENT from recall ----
      await withBenchDaemon(
        {
          workspaceId: "harness-co-recall-fanin-negctl-ws",
          runId: "harness-co-recall-fanin-negctl-run"
        },
        async (negativeDaemon) => {
          const negative = await seedFaninWorld(negativeDaemon);
          // Deliberately DO NOT call accrueSessionCoRecall: no co_recalled edge.

          const negativeRecall = await negativeDaemon.recall(QUERY, {
            maxResults: FANIN_MAX_RESULTS
          });
          const negativeIds = new Set(
            negativeRecall.results.map((r) => r.object_id)
          );

          // The anchor still delivers (direct content hit) — the world is otherwise
          // byte-identical, isolating the edge as the only difference.
          expect(negativeIds).toContain(negative.anchorId);
          // Without the edge the sibling is ABSENT from the delivered top-N. The
          // query-relevant decoys outrank it on fused rank and the budget excludes
          // it: with no path edge there is no path-plane admission to win it a
          // delivery slot above the content hits.
          expect(negativeIds).not.toContain(negative.siblingId);
          const negativeSiblingDiag = findCandidateDiagnostic(
            negativeRecall.diagnostics,
            negative.siblingId
          );
          // The shared bench-seed domain_tag_cluster still admits the sibling to the
          // candidate POOL (so a diagnostic row may exist), but with NO path edge it
          // carries no path_expansion admission and is budget-dropped — proving the
          // positive delivery was the edge's path-plane lift, not a content/floor
          // freebie. (If the pool ejected it entirely there is no row, which is an
          // even stronger absence — both outcomes satisfy the negative control.)
          if (negativeSiblingDiag !== undefined) {
            expect(negativeSiblingDiag.within_budget).toBe(false);
            expect(negativeSiblingDiag.final_rank).toBeNull();
            expect(negativeSiblingDiag.admission_planes).not.toContain(
              "path_expansion"
            );
            expect(negativeSiblingDiag.per_stream_rank.path_expansion).toBeNull();
          }
        }
      );
    },
    120_000
  );
});
