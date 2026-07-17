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

import { withBenchDaemon } from "./bench-daemon.test-support.js";

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

  it("requires an operator embedding secret for explicit OpenAI embedding", async () => {
    const savedOpenAiKey = process.env.OPENAI_API_KEY;
    const savedSecretRef = process.env.ALAYA_OPENAI_SECRET_REF;
    delete process.env.OPENAI_API_KEY;
    delete process.env.ALAYA_OPENAI_SECRET_REF;

    try {
      await expect(
        startBenchDaemon({
          workspaceId: "harness-embedding-missing-ws",
          runId: "harness-embedding-missing-run",
          embeddingMode: "env",
          embeddingProviderKind: "openai"
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
          embeddingMode: "env",
          embeddingProviderKind: "openai"
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
          embeddingMode: "env",
          embeddingProviderKind: "openai"
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
          embeddingMode: "env",
          embeddingProviderKind: "openai"
        })
      ).rejects.toThrow(/missing environment variable ALAYA_MISSING_OPENAI_KEY/);

      process.env.ALAYA_MISSING_OPENAI_KEY = "   ";
      await expect(
        startBenchDaemon({
          workspaceId: "harness-embedding-custom-blank-ws",
          runId: "harness-embedding-custom-blank-run",
          embeddingMode: "env",
          embeddingProviderKind: "openai"
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
          embeddingMode: "env",
          embeddingProviderKind: "openai"
        })
      ).rejects.toThrow(/referenced file is missing/);
    } finally {
      if (savedSecretRef === undefined) delete process.env.ALAYA_OPENAI_SECRET_REF;
      else process.env.ALAYA_OPENAI_SECRET_REF = savedSecretRef;
    }
  });

  it("starts the default local provider without resolving an OpenAI secret", async () => {
    const savedSecretRef = process.env.ALAYA_OPENAI_SECRET_REF;
    const savedOpenAiKey = process.env.OPENAI_API_KEY;
    let handle: BenchDaemonHandle | undefined;
    process.env.ALAYA_OPENAI_SECRET_REF = "file:/tmp/alaya-bench-missing-openai-secret";
    delete process.env.OPENAI_API_KEY;
    try {
      handle = await startBenchDaemon({
        workspaceId: "harness-local-default-ws",
        runId: "harness-local-default-run",
        embeddingMode: "env"
      });
      expect(process.env.ALAYA_EMBEDDING_PROVIDER).toBe("local_onnx");
      expect(process.env.ALAYA_OPENAI_SECRET_REF).toBeUndefined();
      expect(process.env.OPENAI_API_KEY).toBeUndefined();
    } finally {
      await handle?.shutdown();
      if (savedSecretRef === undefined) delete process.env.ALAYA_OPENAI_SECRET_REF;
      else process.env.ALAYA_OPENAI_SECRET_REF = savedSecretRef;
      if (savedOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = savedOpenAiKey;
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

  it("generates reviewer tokens instead of using a static harness secret", () => {
    expect(
      resolveBenchReviewerCredentials({
        options: {},
        savedEnv: {},
        tokenFactory: () => "generated-review-token"
      })
    ).toEqual({
      identity: "user:bench-runner",
      token: "generated-review-token"
    });
  });

  it("warns instead of silently swallowing best-effort close failures", async () => {
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);

    await closeBenchDaemonResources({
      mcpClient: { close: vi.fn(async () => { throw new Error("mcp close failed"); }) },
      server: { close: vi.fn(async () => { throw new Error("server close failed"); }) },
      runtime: { shutdown: vi.fn(async () => { throw new Error("runtime shutdown failed"); }) }
    });

    expect(emitWarning).toHaveBeenCalledWith(
      "[BenchDaemon] best-effort operation failed",
      expect.objectContaining({ code: "ALAYA_BENCH_MCP_CLIENT_CLOSE_FAILED" })
    );
    expect(emitWarning).toHaveBeenCalledWith(
      "[BenchDaemon] best-effort operation failed",
      expect.objectContaining({ code: "ALAYA_BENCH_SERVER_CLOSE_FAILED" })
    );
    expect(emitWarning).toHaveBeenCalledWith(
      "[BenchDaemon] best-effort operation failed",
      expect.objectContaining({ code: "ALAYA_BENCH_RUNTIME_SHUTDOWN_FAILED" })
    );
    emitWarning.mockRestore();
  });

  it("warns when sqlite optimize best-effort refresh fails", async () => {
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const tmpRoot = await mkdtemp(join(tmpdir(), "bench-optimize-warning-"));
    tmpRoots.push(tmpRoot);
    const notDirectory = join(tmpRoot, "not-a-dir");
    await writeFile(notDirectory, "not a directory", "utf8");

    optimizeBenchDb(notDirectory);

    expect(emitWarning).toHaveBeenCalledWith(
      "[BenchDaemon] best-effort operation failed",
      expect.objectContaining({ code: "ALAYA_BENCH_DB_OPTIMIZE_FAILED" })
    );
    emitWarning.mockRestore();
  });

  it(
    "preserves cross-encoder configuration and restores managed env on shutdown",
    async () => {
      const keys = [
        "ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK",
        "ALAYA_LOCAL_CROSS_ENCODER_CACHE_DIR",
        "ALAYA_LOCAL_CROSS_ENCODER_MODEL"
      ] as const;
      const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
      process.env.ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK = "true";
      process.env.ALAYA_LOCAL_CROSS_ENCODER_CACHE_DIR = "/tmp/cross-encoder-cache";
      process.env.ALAYA_LOCAL_CROSS_ENCODER_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";
      const configured = snapshotManagedEnv();

      try {
        await withBenchDaemon(
          {
            workspaceId: "harness-cross-encoder-env-ws",
            runId: "harness-cross-encoder-env-run"
          },
          async () => {
            expect(process.env.ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK).toBe("true");
            expect(process.env.ALAYA_LOCAL_CROSS_ENCODER_CACHE_DIR).toBe(
              "/tmp/cross-encoder-cache"
            );
            expect(process.env.ALAYA_LOCAL_CROSS_ENCODER_MODEL).toBe(
              "Xenova/ms-marco-MiniLM-L-6-v2"
            );
            process.env.ALAYA_LOCAL_CROSS_ENCODER_MODEL = "mutated-by-runtime";
          }
        );
        expect(process.env.ALAYA_LOCAL_CROSS_ENCODER_MODEL).toBe(
          "Xenova/ms-marco-MiniLM-L-6-v2"
        );
        expect(snapshotManagedEnv()).toEqual(configured);
      } finally {
        for (const key of keys) {
          const value = original[key];
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    },
    60_000
  );

  it(
    "uses configured reviewer credentials and restores managed env on shutdown",
    async () => {
      const savedEnv = snapshotManagedEnv();
      await withBenchDaemon(
        {
          workspaceId: "harness-reviewer-config-ws",
          runId: "harness-reviewer-config-run",
          reviewerIdentity: "user:bench-configured-reviewer",
          reviewerToken: "configured-bench-review-token"
        },
        async (daemon) => {
          expect(process.env.ALAYA_REVIEWER_IDENTITY).toBe("user:bench-configured-reviewer");
          expect(process.env.ALAYA_REVIEWER_TOKEN).toBe("configured-bench-review-token");
          const seed = await daemon.proposeMemory(
            "Reviewer credentials should come from bench configuration.",
            "harness-reviewer-config-evidence"
          );
          const row = initDatabase({ filename: join(daemon.dataDir, "alaya.db") })
            .connection.prepare(
              `SELECT reviewer_identity AS reviewerIdentity
                 FROM proposals
                WHERE proposal_id = ?`
            )
            .get(seed.proposalId) as { readonly reviewerIdentity: string };
          expect(row.reviewerIdentity).toBe("user:bench-configured-reviewer");
        }
      );
      // shutdown (inside withBenchDaemon) restores the managed env.
      expect(snapshotManagedEnv()).toEqual(savedEnv);
    },
    60_000
  );
});
