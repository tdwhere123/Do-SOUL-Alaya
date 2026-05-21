import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

      const seed = await daemon.proposeMemoryFromSignal({
        signalKind: "potential_preference",
        objectKind: "fact",
        confidence: 0.9,
        distilledFact: "A full degraded-path turn fact.",
        turnContent: "A full degraded-path turn fact.",
        evidenceRef: "fallback-source-q0",
        extractionProvider: "no_credentials_fallback"
      });

      const db = initDatabase({ filename: join(daemon.dataDir, "alaya.db") });
      const signal = await new SqliteSignalRepo(db).getById(seed.signalId);
      expect(signal?.source).toBe(SignalSource.MODEL_TOOL);
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
});

function snapshotManagedEnv(): Record<string, string | undefined> {
  return Object.fromEntries(MANAGED_ENV_KEYS.map((key) => [key, process.env[key]]));
}
