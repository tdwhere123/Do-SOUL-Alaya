import { mkdtemp, rm } from "node:fs/promises";
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
import { startBenchDaemon, type BenchDaemonHandle } from "../../harness/daemon.js";
import {
  createCompileSeedRunner,
  type CompileSeedExtractionConfig
} from "../../longmemeval/compile-seed.js";

const handles: BenchDaemonHandle[] = [];
const tmpRoots: string[] = [];

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
      // The bench seeds the REAL free-form extracted object_kind (no longer
      // canonicalized onto `fact`), so it exercises the production router
      // exactly. With retainUnroutedHighConfidenceFacts the daemon keeps an
      // unrouted high-confidence claim/preference as a recallable
      // memory_entry_only; this test runs that path and asserts the durable
      // memory_entry is created and recallable. Default-off would drop both to
      // evidence_only (production parity) — see the router unit coverage.
      const startWithRetainFacts = async () => {
        const prev = process.env.ALAYA_RETAIN_UNROUTED_FACTS;
        process.env.ALAYA_RETAIN_UNROUTED_FACTS = "1";
        try {
          return await startBenchDaemon({
            workspaceId: "harness-freeform-kind-ws",
            runId: "harness-freeform-kind-run"
          });
        } finally {
          if (prev === undefined) {
            delete process.env.ALAYA_RETAIN_UNROUTED_FACTS;
          } else {
            process.env.ALAYA_RETAIN_UNROUTED_FACTS = prev;
          }
        }
      };
      const daemon = await startWithRetainFacts();
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
