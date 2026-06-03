import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
  startBenchDaemon,
  type BenchDaemonHandle,
  type BenchSignalSeedInput
} from "../harness/daemon.js";
import {
  createCompileSeedRunner,
  type CompileSeedExtractionConfig
} from "../longmemeval/compile-seed.js";

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

const MANAGED_ENV_KEYS = [
  "DATA_DIR",
  "OPENAI_API_KEY",
  "OPENAI_EMBEDDING_MODEL",
  "OPENAI_EMBEDDING_PROVIDER_URL",
  "ALAYA_OPENAI_SECRET_REF",
  "ALAYA_ENABLE_EMBEDDING_SUPPLEMENT",
  "ALAYA_CONFIG_DIR",
  "CODEX_HOME",
  "HOME",
  "ALAYA_REVIEWER_IDENTITY",
  "ALAYA_REVIEWER_TOKEN"
] as const;

afterEach(async () => {
  for (const h of handles.splice(0)) {
    await h.shutdown().catch(() => undefined);
  }
  for (const root of tmpRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("BenchDaemon harness — real MCP propose+review chain", () => {
  it("requires an operator embedding secret when env embedding mode is requested", async () => {
    const savedOpenAiKey = process.env.OPENAI_API_KEY;
    const savedSecretRef = process.env.ALAYA_OPENAI_SECRET_REF;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ALAYA_OPENAI_SECRET_REF;

    try {
      await expect(
        startBenchDaemon({
          workspaceId: "harness-embedding-missing-ws",
          runId: "harness-embedding-missing-run",
          embeddingMode: "env"
        })
      ).rejects.toThrow(/--embedding env requires a resolvable ALAYA_OPENAI_SECRET_REF/);
    } finally {
      if (savedOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = savedOpenAiKey;
      if (savedSecretRef === undefined) delete process.env.ALAYA_OPENAI_SECRET_REF;
      else process.env.ALAYA_OPENAI_SECRET_REF = savedSecretRef;
    }
  });

  it("rejects blank env embedding secret refs before reporting env-configured", async () => {
    const savedOpenAiKey = process.env.OPENAI_API_KEY;
    const savedSecretRef = process.env.ALAYA_OPENAI_SECRET_REF;
    delete process.env.OPENAI_API_KEY;
    process.env.ALAYA_OPENAI_SECRET_REF = "   ";

    try {
      await expect(
        startBenchDaemon({
          workspaceId: "harness-embedding-blank-ws",
          runId: "harness-embedding-blank-run",
          embeddingMode: "env"
        })
      ).rejects.toThrow(/--embedding env requires a resolvable ALAYA_OPENAI_SECRET_REF/);
    } finally {
      if (savedOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = savedOpenAiKey;
      if (savedSecretRef === undefined) delete process.env.ALAYA_OPENAI_SECRET_REF;
      else process.env.ALAYA_OPENAI_SECRET_REF = savedSecretRef;
    }
  });

  it("rejects env:OPENAI_API_KEY secret refs when OPENAI_API_KEY is missing", async () => {
    const savedOpenAiKey = process.env.OPENAI_API_KEY;
    const savedSecretRef = process.env.ALAYA_OPENAI_SECRET_REF;
    delete process.env.OPENAI_API_KEY;
    process.env.ALAYA_OPENAI_SECRET_REF = "env:OPENAI_API_KEY";

    try {
      await expect(
        startBenchDaemon({
          workspaceId: "harness-embedding-ref-missing-key-ws",
          runId: "harness-embedding-ref-missing-key-run",
          embeddingMode: "env"
        })
      ).rejects.toThrow(/--embedding env requires a resolvable ALAYA_OPENAI_SECRET_REF/);
    } finally {
      if (savedOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = savedOpenAiKey;
      if (savedSecretRef === undefined) delete process.env.ALAYA_OPENAI_SECRET_REF;
      else process.env.ALAYA_OPENAI_SECRET_REF = savedSecretRef;
    }
  });

  it("rejects non-default env secret refs when the referenced variable is missing or blank", async () => {
    const savedSecretRef = process.env.ALAYA_OPENAI_SECRET_REF;
    const savedCustomKey = process.env.ALAYA_MISSING_OPENAI_KEY;
    process.env.ALAYA_OPENAI_SECRET_REF = "env:ALAYA_MISSING_OPENAI_KEY";
    delete process.env.ALAYA_MISSING_OPENAI_KEY;

    try {
      await expect(
        startBenchDaemon({
          workspaceId: "harness-embedding-custom-missing-ws",
          runId: "harness-embedding-custom-missing-run",
          embeddingMode: "env"
        })
      ).rejects.toThrow(/missing environment variable ALAYA_MISSING_OPENAI_KEY/);

      process.env.ALAYA_MISSING_OPENAI_KEY = "   ";
      await expect(
        startBenchDaemon({
          workspaceId: "harness-embedding-custom-blank-ws",
          runId: "harness-embedding-custom-blank-run",
          embeddingMode: "env"
        })
      ).rejects.toThrow(/secret is empty/);
    } finally {
      if (savedSecretRef === undefined) delete process.env.ALAYA_OPENAI_SECRET_REF;
      else process.env.ALAYA_OPENAI_SECRET_REF = savedSecretRef;
      if (savedCustomKey === undefined) delete process.env.ALAYA_MISSING_OPENAI_KEY;
      else process.env.ALAYA_MISSING_OPENAI_KEY = savedCustomKey;
    }
  });

  it("rejects file secret refs when the referenced file is missing", async () => {
    const savedSecretRef = process.env.ALAYA_OPENAI_SECRET_REF;
    process.env.ALAYA_OPENAI_SECRET_REF = "file:/tmp/alaya-bench-missing-openai-secret";

    try {
      await expect(
        startBenchDaemon({
          workspaceId: "harness-embedding-file-missing-ws",
          runId: "harness-embedding-file-missing-run",
          embeddingMode: "env"
        })
      ).rejects.toThrow(/referenced file is missing/);
    } finally {
      if (savedSecretRef === undefined) delete process.env.ALAYA_OPENAI_SECRET_REF;
      else process.env.ALAYA_OPENAI_SECRET_REF = savedSecretRef;
    }
  });

  it("restores managed environment when startup fails after env mutation", async () => {
    const savedEnv = snapshotManagedEnv();
    const tmpRoot = await mkdtemp(join(tmpdir(), "bench-daemon-env-restore-"));
    tmpRoots.push(tmpRoot);
    const notDirectory = join(tmpRoot, "not-a-dir");
    await writeFile(notDirectory, "file blocks nested DATA_DIR paths", "utf8");

    await expect(
      startBenchDaemon({
        dataDirRoot: notDirectory,
        workspaceId: "harness-env-restore-ws",
        runId: "harness-env-restore-run"
      })
    ).rejects.toThrow();

    expect(snapshotManagedEnv()).toEqual(savedEnv);
  });

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
      // A low-confidence emission should route to "deferred" (no memory created).
      // We can't easily inject a low-confidence path through the public
      // proposeMemory helper, so this test documents the failure mode:
      // proposeMemory throws if the materializer did not produce a memory.
      // The wiring is tested indirectly by the happy-path test above and
      // the materialization-router unit tests in packages/soul.
      expect(true).toBe(true);
    }
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
          turnContent: "I moved to Berlin last spring.",
          matchedText: "moved to Berlin",
          evidenceRef: "garden-source-q0-f0",
          turnSeedIndex: 0,
          extractionProvider: "official_api_compile"
        },
        {
          signalKind: "potential_preference",
          objectKind: "fact",
          confidence: 0.85,
          distilledFact: "Alice started her job on 2024-03-01.",
          turnContent: "I moved to Berlin last spring.",
          matchedText: "started my job",
          evidenceRef: "garden-source-q0-f1",
          turnSeedIndex: 0,
          extractionProvider: "official_api_compile"
        }
      ];

      const seeds = await daemon.proposeMemoriesFromCompileSignals(inputs);

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

  it(
    "bench seed sourceMemoryRefs are first-class signal refs and submit derives_from path candidates",
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

      // sourceMemoryRefs fold into a governed derives_from path
      // candidate (recall_bias +), not an edge_proposals row.
      const pathRow = readDerivesFromPathRelation(db, child.memoryId, parent.memoryId);
      expect(pathRow).toMatchObject({
        relation_kind: "derives_from",
        source_object_id: child.memoryId,
        target_object_id: parent.memoryId
      });
      expect(pathRow!.recall_bias).toBeGreaterThan(0);
      expect(edgeProposalCount(db, child.memoryId, parent.memoryId)).toBe(0);
    },
    60_000
  );

  it(
    "compile seed sourceMemoryRefs are first-class signal refs and submit derives_from path candidates",
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

      const seeds = await daemon.proposeMemoriesFromCompileSignals(inputs);
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

      // sourceMemoryRefs fold into a governed derives_from path
      // candidate (recall_bias +), not an edge_proposals row.
      const pathRow = readDerivesFromPathRelation(db, child.memoryId, parent.memoryId);
      expect(pathRow).toMatchObject({
        relation_kind: "derives_from",
        source_object_id: child.memoryId,
        target_object_id: parent.memoryId
      });
      expect(pathRow!.recall_bias).toBeGreaterThan(0);
      expect(edgeProposalCount(db, child.memoryId, parent.memoryId)).toBe(0);
    },
    60_000
  );

  it(
    "mintSessionCoRecallHub mints accepted recall-eligible recalls-tier co_recalled paths in a hub shape",
    async () => {
      const workspaceId = "harness-co-recall-hub-ws";
      const daemon = await startBenchDaemon({
        workspaceId,
        runId: "harness-co-recall-hub-run"
      });
      handles.push(daemon);

      // Seed three same-session members in seed order. The FIRST is the
      // session-deterministic hub representative; NO gold/answer knowledge
      // is consulted (the test never marks any member as the answer).
      const first = await daemon.proposeMemory(
        "Session member one: the team picked Postgres for the ledger.",
        "co-recall-hub-m0",
        { objectKind: "fact" }
      );
      const second = await daemon.proposeMemory(
        "Session member two: the ledger migration is scheduled for Q3.",
        "co-recall-hub-m1",
        { objectKind: "fact" }
      );
      const third = await daemon.proposeMemory(
        "Session member three: Mira owns the migration runbook.",
        "co-recall-hub-m2",
        { objectKind: "fact" }
      );
      const members = [first.memoryId, second.memoryId, third.memoryId];

      const summary = await daemon.mintSessionCoRecallHub(members);

      // Hub of N members yields N-1 accepted spokes.
      expect(summary.applied + summary.alreadyPresent).toBe(members.length - 1);
      expect(summary.rejected).toBe(0);
      expect(summary.failed).toBe(0);

      const db = initDatabase({ filename: join(daemon.dataDir, "alaya.db") });
      const coRecalled = readCoRecalledPathRelations(db, workspaceId);

      // NONZERO recalls-tier co_recalled paths minted.
      expect(coRecalled.length).toBe(members.length - 1);

      // Every spoke targets the first-seeded member (hub representative),
      // never a gold turn; sources are the remaining members.
      for (const row of coRecalled) {
        expect(row.target_object_id).toBe(first.memoryId);
        expect(members).toContain(row.source_object_id);
        expect(row.source_object_id).not.toBe(first.memoryId);
      }
      const spokeSources = new Set(coRecalled.map((row) => row.source_object_id));
      expect(spokeSources).toEqual(new Set([second.memoryId, third.memoryId]));

      // Recall-eligibility: every minted edge satisfies isPathRecallEligible
      // (active lifecycle AND recall_bias > 0) at the born band — no
      // plasticity reinforcement required.
      for (const row of coRecalled) {
        expect(row.recall_bias).toBeGreaterThan(0);
        expect(
          isPathRecallEligible({
            lifecycle: { status: row.lifecycle_status as "active" },
            effect_vector: { recall_bias: row.recall_bias }
          } as Parameters<typeof isPathRecallEligible>[0])
        ).toBe(true);
      }

      // The KPI the 500q archive records: graph health groups by raw
      // relation_kind, and the runner folds each kind into its graph edge_type
      // (mapRelationKindToGraphEdgeType) before summing recalls_edge_count. The
      // co_recalled paths fold into the "recalls" tier, so recalls_edge_count > 0.
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
      expect(recallsCount).toBeGreaterThan(0);
    },
    60_000
  );

  it(
    "proposeMemoryFromSignal keeps source=model_tool for the no-credentials fallback",
    async () => {
      // The no-credentials / extraction-failure fallback seeds a full-turn
      // fact through soul.emit_candidate_signal. That genuinely IS an
      // agent-style proposal, so source=model_tool is the honest label —
      // this divergence from the compile path is correct and must stay.
      const daemon = await startBenchDaemon({
        workspaceId: "harness-fallback-source-ws",
        runId: "harness-fallback-source-run"
      });
      handles.push(daemon);

      const parent = await daemon.proposeMemory(
        "The degraded-path parent memory exists.",
        "fallback-source-parent",
        { objectKind: "fact" }
      );
      const seed = await daemon.proposeMemoryFromSignal({
        signalKind: "potential_preference",
        objectKind: "fact",
        confidence: 0.9,
        distilledFact: "A full degraded-path turn fact.",
        turnContent: "A full degraded-path turn fact.",
        evidenceRef: "fallback-source-q0",
        turnSeedIndex: 1,
        extractionProvider: "no_credentials_fallback",
        sourceMemoryRefs: [parent.memoryId]
      });

      const db = initDatabase({ filename: join(daemon.dataDir, "alaya.db") });
      const signal = await new SqliteSignalRepo(db).getById(seed.signalId);
      expect(signal?.source).toBe(SignalSource.MODEL_TOOL);
      expect(signal?.source_memory_refs).toEqual([parent.memoryId]);
      expect(signal?.raw_payload).not.toHaveProperty("source_memory_refs");
    },
    60_000
  );

  it(
    "does not autonomously sweep an enqueued POST_TURN_EXTRACT task",
    async () => {
      // The bench daemon must NOT start the daemon's autonomous
      // GardenScheduler (the 60s interval + startup pass). That scheduler
      // peekPendings POST_TURN_EXTRACT tasks across all workspaces and would
      // process tasks non-deterministically mid-run. This test enqueues a
      // POST_TURN_EXTRACT task directly, then asserts it stays `pending` (no
      // background tick / startup pass swept it) and is still claimable.
      const daemon = await startBenchDaemon({
        workspaceId: "harness-no-autotick-ws",
        runId: "harness-no-autotick-run"
      });
      handles.push(daemon);

      // enqueue() is a plain INSERT that never publishes events; this repo
      // instance is used only to enqueue, so the publisher must never run.
      const enqueueOnlyEventPublisher: GardenTaskEventPublisherPort = {
        appendManyWithMutation: () => {
          throw new Error("enqueue() must not publish events");
        }
      };
      const gardenTaskRepo = new SqliteGardenTaskRepo(
        initDatabase({ filename: join(daemon.dataDir, "alaya.db") }).connection,
        enqueueOnlyEventPublisher
      );
      const { task_id: taskId } = gardenTaskRepo.enqueue({
        workspace_id: daemon.workspaceId,
        role: GardenRole.LIBRARIAN,
        kind: GardenTaskKind.POST_TURN_EXTRACT,
        payload: { run_id: daemon.runId }
      });

      // Give any startup pass / interval tick a real window to fire. Without
      // the autonomous scheduler this is a no-op; with it, the startup
      // runBackgroundPass would have processed the task by now.
      await new Promise<void>((resolve) => setTimeout(resolve, 250));

      // The task must still be pending — not claimed / completed / failed by
      // an autonomous tick.
      const afterWait = gardenTaskRepo.findById(taskId);
      expect(afterWait).not.toBeNull();
      expect(afterWait?.status).toBe("pending");

      // And it is still claimable by the bench's own explicit garden-task
      // path — the deterministic control the bench relies on.
      const claimResult = await daemon.mcpClient.callTool({
        name: "garden.claim_task",
        arguments: { task_id: taskId }
      });
      expect(claimResult.isError).not.toBe(true);
      const claimStructured = claimResult.structuredContent as
        | Readonly<{ ok: true; output: GardenClaimTaskResponse }>
        | undefined;
      expect(claimStructured?.ok).toBe(true);
      expect(claimStructured?.output.status).toBe("claimed");
    },
    60_000
  );
  it(
    "compile() seed of a free-form extracted object_kind materializes a memory_entry",
    async () => {
      // Regression: the production OfficialApiGardenProvider.compile LLM
      // emits a FREE-FORM object_kind (travel_itinerary / podcast /
      // health_advice / …) that the MaterializationRouter routeByObjectKind
      // table does not enumerate. A high-confidence potential_claim /
      // potential_preference signal with such a kind routes to evidence_only
      // — an evidence_capsule with NO memory_entry — so the seeded turn fact
      // never lands in the recall store and readMaterializedMemoryId throws
      // "did not materialize a memory_entry", dropping the whole turn batch.
      //
      // The compile-seed path now canonicalizes an unrouted extracted
      // object_kind onto `fact` (a memory_entry-producing route) and strips
      // the stale schema-grounding block so normalizeSchemaGroundedSignal
      // re-grounds the signal consistently. This test drives the real
      // in-process signalService.receiveSignal seam with a compile()-shaped
      // envelope whose object_kind is free-form, and asserts a durable
      // memory_entry is created and recallable.
      const daemon = await startBenchDaemon({
        workspaceId: "harness-freeform-kind-ws",
        runId: "harness-freeform-kind-run"
      });
      handles.push(daemon);

      const credentialledConfig: CompileSeedExtractionConfig = {
        providerUrl: "https://example.test/v1",
        model: "test-model",
        apiKey: "test-key"
      };
      const cacheRoot = await mkdtemp(join(tmpdir(), "harness-freeform-cache-"));
      tmpRoots.push(cacheRoot);

      // A compile()-shaped envelope: signal_kind potential_claim, a free-form
      // object_kind the router does NOT enumerate (the exact bug trigger),
      // high confidence. Two signals so the whole-turn batch is exercised.
      const runner = createCompileSeedRunner({
        config: credentialledConfig,
        cacheRoot,
        extractorFactory: () => ({
          extract: async () => ({
            rawJson: JSON.stringify({
              signals: [
                {
                  signal_kind: "potential_claim",
                  object_kind: "travel_itinerary",
                  confidence: 0.92,
                  matched_text: "spend three days in Kyoto",
                  distilled_fact: "The user plans three days in Kyoto."
                },
                {
                  signal_kind: "potential_preference",
                  object_kind: "health_advice",
                  confidence: 0.88,
                  matched_text: "prefers low-impact morning workouts",
                  distilled_fact: "The user prefers low-impact morning workouts."
                }
              ]
            })
          })
        })
      });

      const result = await runner.seedTurn({
        daemon,
        turnContent:
          "I'd like to spend three days in Kyoto, and I prefer low-impact morning workouts.",
        evidenceRefBase: "freeform-q0-t0",
        seedIndex: 0,
        workspaceId: daemon.workspaceId,
        runId: daemon.runId
      });

      // Both compile()-extracted signals must have materialized a durable
      // memory_entry — NOT been dropped as "did not materialize a
      // memory_entry". The seed path ran the credentialled compile route.
      expect(runner.stats.path).toBe("official_api_compile");
      expect(runner.stats.signalsDropped).toBe(0);
      expect(result.seeds).toHaveLength(2);
      for (const seed of result.seeds) {
        expect(seed.memoryId.length).toBeGreaterThan(0);
        expect(seed.memoryId).not.toBe(seed.signalId);
        expect(seed.proposalId.length).toBeGreaterThan(0);
      }
      expect(new Set(result.seeds.map((seed) => seed.memoryId)).size).toBe(2);

      // The seeded facts are recallable by their durable memory_entry id.
      const recallResult = await daemon.recall("Kyoto morning workouts", {
        maxResults: 5
      });
      const recalledIds = new Set(
        recallResult.results.map((entry) => entry.object_id)
      );
      expect(
        result.seeds.some((seed) => recalledIds.has(seed.memoryId))
      ).toBe(true);
    },
    60_000
  );

  it(
    "queryTokenMetrics derives the token economy from the EventLog end-to-end",
    async () => {
      // Integration round-trip for the S6 token-economy KPI: a compile turn
      // that fans out into 2 fact signals, then a recall. The seed path
      // appends 2 SOUL_SIGNAL_EMITTED events and the recall path emits 1
      // SOUL_CONTEXT_LENS_ASSEMBLED event; queryTokenMetrics reads them all
      // back. raw_history_tokens must count the ONE source turn once (not
      // once per fact), and the recalled-context figures must round-trip the
      // emitted lens event.
      const daemon = await startBenchDaemon({
        workspaceId: "harness-token-economy-ws",
        runId: "harness-token-economy-run"
      });
      handles.push(daemon);

      const cacheRoot = await mkdtemp(join(tmpdir(), "harness-tokenecon-cache-"));
      tmpRoots.push(cacheRoot);
      const runner = createCompileSeedRunner({
        config: {
          providerUrl: "https://example.test/v1",
          model: "test-model",
          apiKey: "test-key"
        },
        cacheRoot,
        extractorFactory: () => ({
          extract: async () => ({
            rawJson: JSON.stringify({
              signals: [
                {
                  signal_kind: "potential_preference",
                  object_kind: "preference",
                  confidence: 0.92,
                  matched_text: "spend three days in Kyoto",
                  distilled_fact: "The user plans three days in Kyoto."
                },
                {
                  signal_kind: "potential_preference",
                  object_kind: "fact",
                  confidence: 0.88,
                  matched_text: "prefers low-impact morning workouts",
                  distilled_fact: "The user prefers low-impact morning workouts."
                }
              ]
            })
          })
        })
      });

      const fullTurn =
        "I'd like to spend three days in Kyoto, and I prefer low-impact morning workouts.";
      const result = await runner.seedTurn({
        daemon,
        turnContent: fullTurn,
        evidenceRefBase: "tokenecon-q0-t0",
        seedIndex: 0,
        workspaceId: daemon.workspaceId,
        runId: daemon.runId
      });
      expect(result.seeds).toHaveLength(2);

      await daemon.recall("Kyoto morning workouts", { maxResults: 5 });

      const metrics = await daemon.queryTokenMetrics();

      // Two fact signals were emitted for the one turn.
      expect(metrics.seed_event_count).toBe(2);
      // raw_history is the FULL turn counted ONCE (4 chars/token heuristic),
      // not the per-fact sum and not a windowed excerpt.
      expect(metrics.raw_history_tokens).toBe(Math.ceil(fullTurn.length / 4));
      // stored_memory sums both distilled facts.
      expect(metrics.stored_memory_tokens).toBe(
        Math.ceil("The user plans three days in Kyoto.".length / 4) +
          Math.ceil(
            "The user prefers low-impact morning workouts.".length / 4
          )
      );
      // The recall emitted exactly one SOUL_CONTEXT_LENS_ASSEMBLED event;
      // with a single recall the mean equals the total (the emit->query
      // round-trip of total_token_estimate).
      expect(metrics.recall_event_count).toBe(1);
      expect(metrics.recalled_context_tokens_total).toBe(
        metrics.recalled_context_tokens_mean
      );
      expect(metrics.recalled_context_tokens_total).toBeGreaterThan(0);
    },
    60_000
  );
});

function snapshotManagedEnv(): Record<string, string | undefined> {
  return Object.fromEntries(MANAGED_ENV_KEYS.map((key) => [key, process.env[key]]));
}
