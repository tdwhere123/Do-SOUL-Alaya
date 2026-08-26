// @ts-nocheck
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

import {
  BenchRecallDiagnosticsSchema,
  type BenchRecallDiagnostics
} from "../../../harness/recall/recall-diagnostics-schema.js";

import {
  createCompileSeedRunner,
  type CompileSeedExtractionConfig
} from "../../../bench/compile-seed.js";

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

      // A caller-supplied reference is preserved, but this path does not mint a
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

});
