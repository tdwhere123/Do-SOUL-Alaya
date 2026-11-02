// @ts-nocheck
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SOURCE_STATEMENTS_PROMPT } from "@do-soul/alaya-soul";
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
  GardenTier,
  SignalSource,
  type GardenClaimTaskResponse
} from "@do-soul/alaya-protocol";
import { startBenchDaemon, type BenchDaemonHandle } from "../../../harness/daemon.js";
import { createCompileSeedRunner } from "../../../runs/compile-seed.js";
import { resolveBenchTokenEconomy } from "../../../harness/token/token-economy.js";
import { admitStatementSessionCache, CREDENTIALLED_CONFIG } from
  "../../longmemeval/compile-seed/compile-seed-fixture.js";
import { writeExtractionCacheTestManifest } from "../../longmemeval/extraction/extraction-cache-test-fixture.js";

const handles: BenchDaemonHandle[] = [];
const tmpRoots: string[] = [];
const SOURCE_STATEMENTS = ["I would like to spend three days in Kyoto.", "I prefer low-impact morning workouts."];
const SOURCE_TURN = SOURCE_STATEMENTS.join(" ");

afterEach(async () => {
  vi.restoreAllMocks();
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

      const seed = await daemon.proposeMemoryFromSignal({
        signalKind: "potential_preference",
        objectKind: "fact",
        confidence: 0.9,
        distilledFact: "A full degraded-path turn fact.",
        turnContent: "A full degraded-path turn fact.",
        evidenceRef: "fallback-source-q0",
        turnSeedIndex: 1,
        extractionProvider: "no_credentials_fallback"
      });

      const db = initDatabase({ filename: join(daemon.dataDir, "alaya.db") });
      const signal = await new SqliteSignalRepo(db).getById(seed.signalId);
      expect(signal?.source).toBe(SignalSource.MODEL_TOOL);
      expect(signal?.source_memory_refs).toEqual([]);
    },
    60_000
  );

  it(
    "persists raw_payload canonical_entities onto the materialized memory_entry",
    async () => {
      const daemon = await startBenchDaemon({
        workspaceId: "harness-canonical-entities-ws",
        runId: "harness-canonical-entities-run"
      });
      handles.push(daemon);

      // The compile seed path round-trips canonical_entities through raw_payload
      // (not the first-class signal field); buildMemoryInput must lift + normalize
      // it onto the persisted memory_entry.
      const seed = await daemon.proposeMemoryFromSignal({
        signalKind: "potential_preference",
        objectKind: "fact",
        confidence: 0.9,
        distilledFact: "The operator uses PostgreSQL at Acme.",
        turnContent: "The operator uses PostgreSQL at Acme.",
        evidenceRef: "canonical-entities-q0",
        turnSeedIndex: 1,
        extractionProvider: "official_api_compile",
        productionRawPayload: { canonical_entities: ["Alice", "PostgreSQL"] }
      });

      const db = initDatabase({ filename: join(daemon.dataDir, "alaya.db") });
      const memory = await new SqliteMemoryEntryRepo(db).findById(seed.memoryId);
      expect(memory?.canonical_entities).toEqual(["postgresql"]);
    },
    60_000
  );

  it(
    "does not autonomously sweep an enqueued POST_TURN_EXTRACT task",
    async () => {
      // The bench daemon must NOT start the daemon's autonomous
      // GardenScheduler (the 60s interval + startup pass). That scheduler
      // peekPendings Garden tasks across all workspaces and would
      // process tasks non-deterministically mid-run. This test enqueues a
      // claimable task directly, then asserts it stays `pending` (no
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
      const database = initDatabase({ filename: join(daemon.dataDir, "alaya.db") });
      const gardenTaskRepo = new SqliteGardenTaskRepo(
        database.connection,
        enqueueOnlyEventPublisher
      );
      const { task_id: taskId } = gardenTaskRepo.enqueue({
        workspace_id: daemon.workspaceId,
        role: GardenRole.JANITOR,
        kind: GardenTaskKind.TTL_CLEANUP,
        payload: { task_kind: GardenTaskKind.TTL_CLEANUP, required_tier: GardenTier.TIER_1,
          workspace_id: daemon.workspaceId, run_id: daemon.runId, target_object_refs: [], priority: 20,
          created_at: "2026-05-07T00:00:00.000Z" }
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
      database.close();
    },
    60_000
  );
  it(
    "reports statement-seeded token economy as unavailable instead of zeros",
    async () => {
      // Statement publication carries no bench token projection; the EventLog
      // fold must count those seeds as unprojected, not as an empty history.
      const daemon = await startBenchDaemon({
        workspaceId: "harness-token-economy-ws",
        runId: "harness-token-economy-run"
      });
      handles.push(daemon);

      const cacheRoot = await mkdtemp(join(tmpdir(), "harness-tokenecon-cache-"));
      tmpRoots.push(cacheRoot);
      const config = { ...CREDENTIALLED_CONFIG, sourcePacking: "session-statements" as const };
      writeExtractionCacheTestManifest({ cacheRoot, model: config.model, providerUrl: config.providerUrl,
        systemPrompt: SOURCE_STATEMENTS_PROMPT });
      const turnMessages = [{ message_id: "tokenecon-user-0", role: "user" as const, content: SOURCE_TURN }];
      await admitStatementSessionCache({ cacheRoot, config, messages: turnMessages, rawJson: () => JSON.stringify({
        messages: [{ message_id: "tokenecon-user-0", statements: SOURCE_STATEMENTS.map(text => ({
          text, relation: "recorded statement" })) }] }) });
      const runner = createCompileSeedRunner({ config, cacheRoot, extractorFactory: () => ({
        extract: async () => { throw new Error("admitted statements must not call the live extractor"); }
      }) });

      const result = await runner.seedTurn({
        daemon,
        turnContent: SOURCE_TURN,
        turnMessages,
        evidenceRefBase: "tokenecon-q0-t0",
        seedIndex: 0,
        workspaceId: daemon.workspaceId,
        runId: daemon.runId
      });
      expect(result.seeds).toHaveLength(2);

      await daemon.recall("Kyoto morning workouts", { maxResults: 5 });

      const metrics = await daemon.queryTokenMetrics();

      expect(metrics).toMatchObject({ seed_event_count: 0, raw_history_tokens: 0,
        unprojected_statement_seed_event_count: 2, recall_event_count: 1 });
      expect(resolveBenchTokenEconomy("public", [metrics])).toEqual({
        tokenEconomy: { schema_version: "bench-token-economy-unavailable.v1",
          reason: "statement_seed_no_token_projection", unprojected_seed_event_count: 2 },
        tokenSavedRatio: null
      });
    },
    60_000
  );
});
