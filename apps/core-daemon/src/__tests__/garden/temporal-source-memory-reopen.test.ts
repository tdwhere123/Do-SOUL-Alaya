import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EventPublisher, EvidenceService, MemoryService, SignalService, createSignalEmissionWriter } from "@do-soul/alaya-core";
import { InMemoryHandoffGapHandler, MaterializationRouter, OfficialApiGardenProvider, auditOfficialApiSignalFormation } from "@do-soul/alaya-soul";
import {
  initDatabase, SqliteEvidenceCapsuleRepo, SqliteEventLogRepo,
  SqliteMemoryEntryRepo, SqliteWorkspaceRepo, SqliteRunRepo, SqliteSignalRepo
} from "@do-soul/alaya-storage";
import { createOpenSemanticExtractor } from "../../../../../packages/soul/src/__tests__/garden/ingestion/compute-provider-fixtures.js";

const OBSERVED_AT = "2024-01-01T00:30:00+14:00";
const CREATED_AT = "2026-09-14T12:00:00.000Z";
const CASES = [
  { source: "I released the product in 2016.", eventStart: "2016-01-01T00:00:00.000Z", eventEnd: "2016-12-31T23:59:59.999Z", validStart: null },
  { source: "This policy is valid from May 2023.", eventStart: null, eventEnd: null, validStart: "2023-05-01T00:00:00.000Z" },
  { source: "I own model 2016.", eventStart: null, eventEnd: null, validStart: null },
  { source: "I worked last year.", eventStart: "2022-12-31T10:00:00.000Z", eventEnd: "2023-12-31T09:59:59.999Z", validStart: null }
] as const;

describe("source temporal projection persistence", () => {
  it("stores inclusive windows and separate validity through Garden and reopens the original source clock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "alaya-source-time-"));
    const filename = join(directory, "memory.sqlite");
    let database = initDatabase({ filename });
    try {
      await new SqliteWorkspaceRepo(database).create({ workspace_id: "workspace-1", name: "workspace",
        root_path: directory, workspace_kind: "local_repo", default_engine_binding: null, workspace_state: "active" });
      await new SqliteRunRepo(database).create({ run_id: "run-1", workspace_id: "workspace-1", title: "run", goal: null,
        run_mode: "chat", engine_binding_id: null, engine_class: null, run_state: "idle", current_surface_id: null });
      const eventLogRepo = new SqliteEventLogRepo(database);
      const evidenceRepo = new SqliteEvidenceCapsuleRepo(database);
      const notifier = { notifyEntry: async () => undefined, notify: async () => undefined };
      const evidenceService = new EvidenceService({ evidenceCapsuleRepo: evidenceRepo, eventLogRepo,
        runtimeNotifier: notifier, now: () => CREATED_AT, generateObjectId: randomUUID });
      const memoryService = new MemoryService({ memoryEntryRepo: new SqliteMemoryEntryRepo(database), eventLogRepo,
        evidenceService: evidenceRepo, runtimeNotifier: notifier, now: () => CREATED_AT, generateObjectId: randomUUID });
      const router = new MaterializationRouter({ evidenceService, memoryService,
        synthesisService: { create: async () => { throw new Error("unexpected synthesis route"); } },
        claimService: { create: async () => { throw new Error("unexpected claim route"); } },
        handoffGapHandler: new InMemoryHandoffGapHandler(), fullTurnEvidenceExcerpt: true });
      const signalRepo = new SqliteSignalRepo(database);
      const eventPublisher = new EventPublisher({ eventLogRepo, runtimeNotifier: notifier,
        runHotStateService: { apply: async () => undefined } });
      const signalService = new SignalService({ eventLogRepo, signalRepo, runtimeNotifier: notifier,
        emissionWriter: createSignalEmissionWriter({ eventPublisher, signalRepo }),
        postTriageMaterializer: { materialize: (signal, context) => router.materializeSignal(signal, context) } });
      const persisted: { memoryId: string; source: string; evidenceId: string }[] = [];
      for (const fixture of CASES) {
        const raw = JSON.stringify({ signals: [{ object_kind: "fact", confidence: 0.9,
          matched_text: fixture.source, distilled_fact: fixture.source }] });
        const extractor = createOpenSemanticExtractor(raw);
        const [signal] = await new OfficialApiGardenProvider({ apiKey: "local-test", extractor,
          generateSignalId: randomUUID, now: () => CREATED_AT }).compile(fixture.source, {
          workspace_id: "workspace-1", run_id: "run-1", surface_id: null, turn_messages: [],
          allow_legacy_single_user_source: true, source_observed_at: OBSERVED_AT
        });
        expect(signal).toBeDefined();
        // The host owns the trusted observation receipt; the extractor does not.
        const received = await signalService.receiveSignal({ ...signal!, source_observation: {
          observed_at: "2023-12-31T10:30:00.000Z", authority: "trusted_host_event", source_event_id: "source-clock"
        } });
        const materialized = received.materialization;
        expect(materialized?.success).toBe(true);
        const memoryId = materialized?.created_objects.find((object) => object.object_kind === "memory_entry")?.object_id;
        const evidenceId = materialized?.created_objects.find((object) => object.object_kind === "evidence_capsule")?.object_id;
        expect(memoryId).toBeDefined();
        expect(evidenceId).toBeDefined();
        persisted.push({ memoryId: memoryId!, evidenceId: evidenceId!, source: fixture.source });
        // Historical raw is reinterpreted by the same current formation owner;
        // the receipt's replay time must not replace the source observation.
        const extracted = await extractor.extract({ systemPrompt: "local", userPrompt: "local" });
        const replay = auditOfficialApiSignalFormation({ raw_json: extracted.rawJson,
          turn_content: fixture.source, allow_legacy_single_user_source: true,
          workspace_id: "workspace-1", run_id: "run-1", surface_id: null,
          created_at: "2030-01-01T00:00:00.000Z", source_observed_at: OBSERVED_AT, signal_id_for: () => randomUUID() });
        expect(replay.entries[0]?.signal?.raw_payload.temporal_projection).toEqual(signal?.raw_payload.temporal_projection);
      }
      database.close();
      database = initDatabase({ filename });
      const reopenedMemories = new SqliteMemoryEntryRepo(database);
      const reopenedEvidence = new SqliteEvidenceCapsuleRepo(database);
      for (const [index, saved] of persisted.entries()) {
        const fixture = CASES[index]!;
        const memory = await reopenedMemories.findById(saved.memoryId);
        expect(memory?.content).toBe(saved.source);
        expect(memory?.event_time_start ?? null).toBe(fixture.eventStart);
        expect(memory?.event_time_end ?? null).toBe(fixture.eventEnd);
        expect(memory?.valid_from ?? null).toBe(fixture.validStart);
        expect(memory?.valid_to ?? null).toBeNull();
        const evidence = await reopenedEvidence.findById(saved.evidenceId);
        expect(evidence?.excerpt).toContain(saved.source);
        expect(evidence?.event_anchor?.occurred_at).toBe("2023-12-31T10:30:00.000Z");
        expect(memory?.created_at).toBe(CREATED_AT);
      }
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
