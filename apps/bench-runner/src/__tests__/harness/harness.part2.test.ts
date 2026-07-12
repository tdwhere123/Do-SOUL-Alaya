import { access, mkdtemp, rm, writeFile } from "node:fs/promises";

import { tmpdir } from "node:os";

import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  initDatabase,
  SqliteGardenTaskRepo,
  SqliteMemoryEntryRepo,
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
} from "../../harness/daemon.js";

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

  it(
    "enforces one active bench daemon per process",
    async () => {
      const daemon = await startBenchDaemon({
        workspaceId: "harness-single-daemon-ws",
        runId: "harness-single-daemon-run"
      });
      handles.push(daemon);

      await expect(
        startBenchDaemon({
          workspaceId: "harness-second-daemon-ws",
          runId: "harness-second-daemon-run"
        })
      ).rejects.toThrow(/only one active daemon per process/);
    },
    60_000
  );

  it(
    "cleans up managed attachWorkspace roots without deleting the daemon data root",
    async () => {
      const daemon = await startBenchDaemon({
        workspaceId: "harness-managed-root-default-ws",
        runId: "harness-managed-root-default-run"
      });
      handles.push(daemon);
      const workspace = await daemon.attachWorkspace({
        workspaceId: "harness-managed-root-ws",
        runId: "harness-managed-root-run"
      });

      const row = initDatabase({ filename: join(daemon.dataDir, "alaya.db") })
        .connection.prepare(
          `SELECT root_path AS rootPath
             FROM workspaces
            WHERE workspace_id = ?`
        )
        .get(workspace.workspaceId) as { readonly rootPath: string };

      expect(row.rootPath).toContain(join(daemon.dataDir, "bench-workspaces"));
      await expect(access(row.rootPath)).resolves.toBeUndefined();

      await workspace.detach();

      await expect(access(row.rootPath)).rejects.toThrow();
      await expect(access(daemon.dataDir)).resolves.toBeUndefined();
    },
    60_000
  );

  it(
    "emit_candidate_signal -> propose_memory_update -> review_memory_proposal accept produces recallable memory",
    async () => {
      const daemon = await startBenchDaemon({
        workspaceId: "harness-test-ws",
        runId: "harness-test-run"
      });
      handles.push(daemon);

      expect(daemon.runtime).toBeDefined();
      expect(daemon.mcpClient).toBeDefined();
      expect(daemon.workspaceId).toBe("harness-test-ws");

      // MCP tools are registered after install + attach
      const toolsList = await daemon.mcpClient.listTools();
      const toolNames = toolsList.tools.map((t) => t.name);
      expect(toolNames).toContain("soul.recall");
      expect(toolNames).toContain("soul.emit_candidate_signal");
      expect(toolNames).toContain("soul.propose_memory_update");
      expect(toolNames).toContain("soul.review_memory_proposal");

      // Drive the full propose+review chain.
      const content = "Use pnpm for all workspace commands in this monorepo.";
      const seed = await daemon.proposeMemory(content, "harness-evidence-001");

      // Each step returns a distinct durable id; the harness exposes all
      // three so the caller can build a sidecar keyed on memoryId.
      expect(typeof seed.memoryId).toBe("string");
      expect(seed.memoryId.length).toBeGreaterThan(0);
      expect(typeof seed.signalId).toBe("string");
      expect(seed.signalId.length).toBeGreaterThan(0);
      expect(typeof seed.proposalId).toBe("string");
      expect(seed.proposalId.length).toBeGreaterThan(0);
      expect(seed.memoryId).not.toBe(seed.signalId);
      expect(seed.memoryId).not.toBe(seed.proposalId);

      // Recall must find the seeded memory and the recall pointer's
      // object_id MUST equal the durable memoryId. That is the scoring contract.
      const recallResult = await daemon.recall("pnpm workspace commands", { maxResults: 5 });
      expect(Array.isArray(recallResult.results)).toBe(true);
      const recalledIds = recallResult.results.map((r) => r.object_id);
      expect(recalledIds).toContain(seed.memoryId);
      const diagnostics = recallResult.diagnostics as
        | { readonly delivered_count?: number; readonly candidates?: readonly { readonly object_id: string; readonly final_rank: number | null }[] }
        | undefined;
      expect(diagnostics?.delivered_count).toBe(recallResult.results.length);
      const seededDiagnostic = diagnostics?.candidates?.find(
        (candidate) => candidate.object_id === seed.memoryId
      );
      expect(seededDiagnostic?.final_rank).not.toBeNull();
    },
    60_000
  );

  it(
    "does not expose draft claim-backed constraint seeds as active constraints",
    async () => {
      const daemon = await startBenchDaemon({
        workspaceId: "harness-draft-constraint-ws",
        runId: "harness-draft-constraint-run"
      });
      handles.push(daemon);

      const seed = await daemon.proposeMemory(
        "Do not mark draft agent suggestions as hard constraints.",
        "harness-evidence-draft-constraint",
        { objectKind: "constraint" }
      );

      const recallResult = await daemon.recall("draft agent hard constraints", { maxResults: 5 });
      expect(recallResult.results.map((result) => result.object_id)).toContain(seed.memoryId);
      expect((recallResult.active_constraints ?? []).map((constraint) => constraint.object_id)).not.toContain(
        seed.memoryId
      );
      expect(recallResult.active_constraints_count ?? 0).toBe(0);
    },
    60_000
  );

  it(
    "rejects seeds when signal does not materialize a memory_entry",
    async () => {
      const daemon = await startBenchDaemon({
        workspaceId: "harness-deferred-ws",
        runId: "harness-deferred-run"
      });
      handles.push(daemon);

      // confidence 0.1 (< router floor 0.5 and < 0.3) routes the signal to
      // "deferred" — no memory_entry. Driven through the same in-process
      // signalService.receiveSignal seam the production POST_TURN_EXTRACT path uses.
      const { seeds, dropped } = await daemon.proposeMemoriesFromCompileSignals([
        {
          signalKind: "potential_preference",
          objectKind: "preference",
          confidence: 0.1,
          distilledFact: "Bob might prefer tea, unconfirmed.",
          turnContent: "Maybe I sometimes drink tea, not sure.",
          matchedText: "drink tea",
          evidenceRef: "harness-deferred-q0-f0",
          turnSeedIndex: 0,
          extractionProvider: "official_api_compile"
        }
      ]);

      expect(seeds).toHaveLength(0);
      expect(dropped).toHaveLength(1);
      expect(dropped[0]?.reason).toBe("candidate_absent");

      // The materialization-router deferred the signal: no memory_entry exists.
      const db = initDatabase({ filename: join(daemon.dataDir, "alaya.db") });
      const memoryRepo = new SqliteMemoryEntryRepo(db);
      const memories = await memoryRepo.findByWorkspaceIdAll(daemon.workspaceId);
      expect(memories).toHaveLength(0);
    },
    60_000
  );

  it(
    "proposeMemoriesFromCompileSignals materializes signals with source=garden_compile",
    async () => {
      // The compile-based bench seed path must materialize through the
      // daemon's in-process signalService.receiveSignal — the same seam
      // production POST_TURN_EXTRACT completion uses — with source built as
      // garden_compile. soul.emit_candidate_signal would instead hardcode
      // source=model_tool, which downstream toFormationKind maps to
      // `inferred` (confidence base 0.4) rather than `extracted` (0.6),
      // seeding ~33% lower retention than the production POST_TURN_EXTRACT
      // path. This test reads the persisted signal and asserts the source
      // is garden_compile — production-faithful — for every seeded signal.
      const daemon = await startBenchDaemon({
        workspaceId: "harness-garden-source-ws",
        runId: "harness-garden-source-run"
      });
      handles.push(daemon);

      const inputs: readonly BenchSignalSeedInput[] = [
        {
          signalKind: "potential_preference",
          objectKind: "preference",
          confidence: 0.9,
          distilledFact: "Alice lives in Berlin.",
          turnContent: "I moved to Berlin last spring. I started my job in March 2024.",
          matchedText: "moved to Berlin",
          evidenceRef: "garden-source-q0-f0",
          turnSeedIndex: 0,
          extractionProvider: "official_api_compile",
          sourceObservedAt: "2026-02-03T04:05:06.000Z"
        },
        {
          signalKind: "potential_preference",
          objectKind: "fact",
          confidence: 0.85,
          distilledFact: "Alice started her job on 2024-03-01.",
          turnContent: "I moved to Berlin last spring. I started my job in March 2024.",
          matchedText: "started my job",
          evidenceRef: "garden-source-q0-f1",
          turnSeedIndex: 0,
          extractionProvider: "official_api_compile"
        }
      ];

      const { seeds, dropped } = await daemon.proposeMemoriesFromCompileSignals(inputs);

      expect(dropped).toHaveLength(0);
      expect(seeds).toHaveLength(2);
      expect(new Set(seeds.map((seed) => seed.memoryId)).size).toBe(2);

      // Read each materialized signal's persisted record and assert
      // source=garden_compile (the production POST_TURN_EXTRACT source).
      const db = initDatabase({ filename: join(daemon.dataDir, "alaya.db") });
      const signalRepo = new SqliteSignalRepo(db);
      for (const seed of seeds) {
        const signal = await signalRepo.getById(seed.signalId);
        expect(signal).not.toBeNull();
        expect(signal?.source).toBe(SignalSource.GARDEN_COMPILE);
        if (seed === seeds[0]) {
          expect(signal?.created_at).toBe("2026-02-03T04:05:06.000Z");
        }
      }

      // The full audit/accept chain still ran: every seed carries a
      // distinct durable memory id, a signal id, and a proposal id.
      for (const seed of seeds) {
        expect(seed.memoryId.length).toBeGreaterThan(0);
        expect(seed.proposalId.length).toBeGreaterThan(0);
        expect(seed.memoryId).not.toBe(seed.signalId);
      }

      // The seeded memories are recallable by their durable object_id.
      const recallResult = await daemon.recall("Berlin job", { maxResults: 5 });
      const recalledIds = new Set(recallResult.results.map((r) => r.object_id));
      expect(seeds.some((seed) => recalledIds.has(seed.memoryId))).toBe(true);
    },
    60_000
  );
});
