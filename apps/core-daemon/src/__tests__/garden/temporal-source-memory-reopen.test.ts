import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { EventPublisher, EvidenceService, MemoryService, SignalService, createSignalEmissionWriter } from "@do-soul/alaya-core";
import { InMemoryHandoffGapHandler, LocalHeuristics, MaterializationRouter, OfficialApiGardenProvider,
  auditOfficialApiSignalFormation, buildOfficialApiExtractionRequests } from "@do-soul/alaya-soul";
import {
  initDatabase, SqliteEvidenceCapsuleRepo, SqliteEventLogRepo,
  SqliteMemoryEntryRepo, SqliteWorkspaceRepo, SqliteRunRepo, SqliteSignalRepo, SqliteSourceGroundingDeferQueueRepo
} from "@do-soul/alaya-storage";
import { createOpenSemanticExtractor } from "../../../../../packages/soul/src/__tests__/garden/ingestion/compute-provider-fixtures.js";
import { createSourceGroundingDeferTransitions } from "../../runtime/source-grounding-defer/transitions.js";

const OBSERVED_AT = "2024-01-01T00:30:00+14:00";
const CREATED_AT = "2026-09-14T12:00:00.000Z";
interface TemporalCase {
  readonly source: string;
  readonly eventStart: string | null;
  readonly eventEnd: string | null;
  readonly validStart: string | null;
  readonly validEnd?: string;
  readonly nomination?: Record<string, unknown>;
  readonly audit?: "formed" | "rejected" | "unavailable";
  readonly localMatch?: string;
  readonly deferred?: true;
}
const CASES: readonly TemporalCase[] = [
  { source: "I released the product in 2016.", eventStart: "2016-01-01T00:00:00.000Z", eventEnd: "2016-12-31T23:59:59.999Z", validStart: null },
  { source: "This policy is valid from May 2023.", eventStart: null, eventEnd: null, validStart: "2023-05-01T00:00:00.000Z" },
  { source: "I own model 2016.", eventStart: null, eventEnd: null, validStart: null },
  { source: "I launched an effective product in 2016.", eventStart: "2016-01-01T00:00:00.000Z", eventEnd: "2016-12-31T23:59:59.999Z", validStart: null },
  { source: "I launched the product in 2016 with an effective team.", eventStart: "2016-01-01T00:00:00.000Z", eventEnd: "2016-12-31T23:59:59.999Z", validStart: null },
  { source: "I have a permit valid from 2016 to 2017.", eventStart: null, eventEnd: null,
    validStart: "2016-01-01T00:00:00.000Z", validEnd: "2017-12-31T23:59:59.999Z", audit: "rejected",
    nomination: { projection_schema_version: 1, valid_from: "2016-01-01T00:00:00.000Z", time_precision: "year", time_source: "explicit" } },
  { source: "I have a permit valid from 2016 to 2017.", eventStart: null, eventEnd: null,
    validStart: "2016-01-01T00:00:00.000Z", validEnd: "2017-12-31T23:59:59.999Z", audit: "rejected",
    nomination: { projection_schema_version: 1, valid_from: "2016-01-01T00:00:00.000Z", valid_to: "2016-12-31T23:59:59.999Z", time_precision: "year", time_source: "explicit" } },
  { source: "I have a permit valid from 2016 to 2017.", eventStart: null, eventEnd: null,
    validStart: "2016-01-01T00:00:00.000Z", validEnd: "2017-12-31T23:59:59.999Z", audit: "formed",
    nomination: { projection_schema_version: 1, valid_from: "2016-01-01T00:00:00.000Z", valid_to: "2017-12-31T23:59:59.999Z", time_precision: "range", time_source: "explicit" } },
  { source: "I worked from January 1, 2016 until January 3, 2016 (exclusive).", eventStart: null, eventEnd: null, validStart: null },
  { source: "I worked from January 1, 2016 to January 3, 2016 (exclusive).", eventStart: null, eventEnd: null, validStart: null,
    audit: "rejected", nomination: { projection_schema_version: 1, event_time_start: "2016-01-01T00:00:00.000Z", event_time_end: "2016-01-03T23:59:59.999Z", time_precision: "range", time_source: "explicit" } },
  { source: "I worked from January 1, 2016 through January 3, 2016.", eventStart: "2016-01-01T00:00:00.000Z", eventEnd: "2016-01-03T23:59:59.999Z", validStart: null },
  { source: "I worked last year.", eventStart: "2022-12-31T10:00:00.000Z", eventEnd: "2023-12-31T09:59:59.999Z", validStart: null }
];

const LATER_EVENT = { projection_schema_version: 1, event_time_start: "2017-01-01T00:00:00.000Z",
  event_time_end: "2017-12-31T23:59:59.999Z", time_precision: "year", time_source: "explicit" };
const LATER_VALIDITY = { projection_schema_version: 1, valid_from: "2017-01-01T00:00:00.000Z",
  time_precision: "year", time_source: "explicit" };
const NO_TIME = { eventStart: null, eventEnd: null, validStart: null };
const CONTEXT_CASES: readonly TemporalCase[] = [
  { source: "I announced in 2016 a policy effective from 2017.", ...NO_TIME, audit: "unavailable" },
  { source: "I announced in 2016 a policy effective from 2017.", ...NO_TIME, nomination: LATER_EVENT, audit: "rejected" },
  { source: "I announced in 2016 a policy effective from 2017.", ...NO_TIME, validStart: LATER_VALIDITY.valid_from,
    nomination: LATER_VALIDITY, audit: "formed" },
  { source: "I announced in 2016 a policy valid from 2017.", ...NO_TIME, nomination: LATER_EVENT, audit: "rejected" },
  { source: "I announced in 2016 a policy valid from 2017.", ...NO_TIME, validStart: LATER_VALIDITY.valid_from,
    nomination: LATER_VALIDITY, audit: "formed" },
  { source: "I announced in 2016 a policy effective from 2017.", ...NO_TIME, localMatch: "2017" },
  { source: `I have a permit valid from ${"\t ".repeat(64)}2017.`, ...NO_TIME, localMatch: "2017" },
  { source: "I released the product on 2016-02/03 or in 2017.", ...NO_TIME, audit: "unavailable" },
  { source: "I released the product on 2016-02/03 or in 2017.", ...NO_TIME, nomination: LATER_EVENT, audit: "rejected" },
  { source: "I released the product on 2016-02/03 or in 2017.", ...NO_TIME, nomination: LATER_VALIDITY, audit: "rejected" },
  { source: "I released the product on 2016-02-03x or in 2017.", ...NO_TIME, audit: "unavailable" },
  { source: "I worked from 2016-02/03 to 2017.", ...NO_TIME, audit: "unavailable" },
  { source: "I released the product on 2016-02/03 or in 2017.", ...NO_TIME, localMatch: "in 2017" }
];
const ARGUMENT_CASES: readonly TemporalCase[] = [
  { source: "I released the product in 2016/17 or in 2017.", ...NO_TIME, audit: "unavailable" },
  { source: "I released the product in 2016/17 or in 2017.", ...NO_TIME, nomination: LATER_EVENT, audit: "rejected" },
  { source: "I released the product in 2016/17 or in 2017.", ...NO_TIME, nomination: LATER_VALIDITY, audit: "rejected" },
  { source: "I released the product in 2016/17 or in 2017.", ...NO_TIME, localMatch: "in 2017" },
  { source: "I released the product on 2016/02/03 or in 2017.", ...NO_TIME, audit: "unavailable" },
  { source: "我在2016/02/03或在2017年发布产品。", ...NO_TIME, audit: "unavailable" },
  { source: "I released the product on Christmas or in 2017.", ...NO_TIME, audit: "unavailable" },
  { source: "I released the product on Christmas or in 2017.", ...NO_TIME, nomination: LATER_EVENT, audit: "rejected" },
  { source: "I released the product on Christmas or in 2017.", ...NO_TIME, nomination: LATER_VALIDITY, audit: "rejected" },
  { source: "I released the product on Christmas or maybe in 2017.", ...NO_TIME, audit: "unavailable" },
  { source: "I released the product on Christmas or maybe in 2017.", ...NO_TIME, localMatch: "in 2017" },
  { source: "I released the product on Christmas or, by and large, in 2017.", ...NO_TIME, audit: "unavailable" },
  { source: "I released the product on Christmas or, by and large, in 2017.", ...NO_TIME, nomination: LATER_EVENT, audit: "rejected" },
  { source: "I released the product on Christmas or e.g. in 2017.", ...NO_TIME, audit: "unavailable" },
  { source: "I released the product on Christmas or e.g. in 2017.", ...NO_TIME, nomination: LATER_VALIDITY, audit: "rejected" },
  { source: "I released the product on Christmas or e.g. in 2017.", ...NO_TIME, localMatch: "in 2017", deferred: true },
  { source: "I released the product in an unknown year or in 2017.", ...NO_TIME, audit: "unavailable" },
  { source: "I have a permit valid from 2017 to Christmas.", ...NO_TIME, nomination: LATER_VALIDITY, audit: "rejected" },
  { source: "I released a product or a service in 2017.", eventStart: LATER_EVENT.event_time_start,
    eventEnd: LATER_EVENT.event_time_end, validStart: null, audit: "formed" },
  { source: "I released the product in 2016 to help people.", eventStart: "2016-01-01T00:00:00.000Z",
    eventEnd: "2016-12-31T23:59:59.999Z", validStart: null, audit: "formed" },
  { source: "SHADOW’s original product was released in 2016 with the promise of allowing all individuals to enjoy the power of a high-end PC from the cloud.",
    eventStart: "2016-01-01T00:00:00.000Z", eventEnd: "2016-12-31T23:59:59.999Z", validStart: null, audit: "formed" },
  { source: "I released the product in 2016 to help people.",
    eventStart: "2016-01-01T00:00:00.000Z", eventEnd: "2016-12-31T23:59:59.999Z", validStart: null, localMatch: "2016" }
];

describe("source temporal projection persistence", () => {
  it.each([
    { name: "stores inclusive windows and separate validity through Garden and reopens the original source clock", cases: CASES, catalog: false },
    { name: "retains temporal context and rejected branches through live replay and SQLite reopen", cases: CONTEXT_CASES, catalog: true },
    { name: "retains unparsed temporal arguments through live replay and SQLite reopen", cases: ARGUMENT_CASES, catalog: true }
  ])("$name", async ({ cases, catalog }) => {
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
      const admit = vi.fn(async () => ({ object_kind: "relation_assertion", object_id: randomUUID() }));
      const router = new MaterializationRouter({ evidenceService, memoryService,
        temporalRelationAssertionPort: { admit },
        synthesisService: { create: async () => { throw new Error("unexpected synthesis route"); } },
        claimService: { create: async () => { throw new Error("unexpected claim route"); } },
        handoffGapHandler: new InMemoryHandoffGapHandler(), fullTurnEvidenceExcerpt: true });
      const signalRepo = new SqliteSignalRepo(database);
      const queueRepo = new SqliteSourceGroundingDeferQueueRepo(database);
      const eventPublisher = new EventPublisher({ eventLogRepo, runtimeNotifier: notifier,
        runHotStateService: { apply: async () => undefined } });
      const signalService = new SignalService({ eventLogRepo, signalRepo, runtimeNotifier: notifier,
        emissionWriter: createSignalEmissionWriter({ eventPublisher, signalRepo }),
        sourceGroundingDeferQueue: queueRepo,
        sourceGroundingDeferTransitions: createSourceGroundingDeferTransitions({ eventLogRepo, signalRepo, queueRepo }),
        postTriageMaterializer: { materialize: (signal, context) => router.materializeSignal(signal, context) } });
      const persisted: { memoryId: string; fixture: TemporalCase; evidenceId: string }[] = [];
      const deferred: { signalId: string; source: string }[] = [];
      for (const [index, fixture] of cases.entries()) {
        admit.mockClear();
        const signalId = `temporal-signal-${index}`;
        const messages = catalog ? [{ message_id: `source-${index}`, role: "user" as const, content: fixture.source }] : [];
        const context = { workspace_id: "workspace-1", run_id: "run-1", surface_id: null, turn_messages: messages,
          allow_legacy_single_user_source: !catalog, source_observed_at: OBSERVED_AT };
        const assertion = catalog ? buildOfficialApiExtractionRequests(fixture.source, messages)
          .flatMap((request) => request.source_assertions).find((entry) => entry.text === `User: ${fixture.source}`) : undefined;
        if (catalog && fixture.localMatch === undefined) expect(assertion).toBeDefined();
        const raw = JSON.stringify({ signals: [{ object_kind: "fact", confidence: 0.9,
          matched_text: fixture.source, distilled_fact: fixture.source,
          ...(assertion === undefined ? {} : { source_locator: { contract_version: 3, kind: "assertion_catalog", assertion_id: assertion.assertion_id } }),
          ...(fixture.nomination === undefined ? {} : { temporal_projection: fixture.nomination }) }] });
        const extractor = createOpenSemanticExtractor(raw);
        const signal = fixture.localMatch === undefined
          ? (await new OfficialApiGardenProvider({ apiKey: "local-test", extractor,
              generateSignalId: () => signalId, now: () => CREATED_AT }).compile(fixture.source, context))[0]
          : (await new LocalHeuristics().compile(fixture.source, context))
              .find((candidate) => candidate.raw_payload.matched_text === fixture.localMatch);
        expect(signal).toBeDefined();
        if (fixture.audit !== undefined) expect(signal!.raw_payload.temporal_projection_audit).toMatchObject({ status: fixture.audit });
        // The host owns the trusted observation receipt; the extractor does not.
        const received = await signalService.receiveSignal({ ...signal!, source_observation: {
          observed_at: "2023-12-31T10:30:00.000Z", authority: "trusted_host_event", source_event_id: "source-clock"
        } }).catch((cause: unknown) => {
          throw new Error(`Temporal source failed materialization (${fixture.localMatch ?? "official"}): ${fixture.source}`, { cause });
        });
        const materialized = received.materialization;
        if (fixture.deferred) {
          expect(received.triage_result).toBe("deferred");
          expect(materialized?.target_kind).toBe("deferred");
          expect(materialized?.created_objects).toEqual([]);
          expect(signal!.raw_payload.temporal_projection).toBeUndefined();
          expect(admit).not.toHaveBeenCalled();
          deferred.push({ signalId: signal!.signal_id, source: fixture.source });
          continue;
        }
        expect(materialized?.success).toBe(true);
        if (fixture.source === "I worked last year.") {
          expect(admit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            relationKind: "time_concern",
            anchors: expect.objectContaining({ target_anchor: expect.objectContaining({
              kind: "time_concern", window_digest: "time_window_v1:1672480800000:1704016799999"
            }) }),
            sourceEventAnchor: expect.objectContaining({ occurred_at: "2023-12-31T10:30:00.000Z" })
          }));
        }
        const memoryId = materialized?.created_objects.find((object) => object.object_kind === "memory_entry")?.object_id;
        const evidenceId = materialized?.created_objects.find((object) => object.object_kind === "evidence_capsule")?.object_id;
        expect(memoryId).toBeDefined();
        expect(evidenceId).toBeDefined();
        persisted.push({ memoryId: memoryId!, evidenceId: evidenceId!, fixture });
        // Historical raw is reinterpreted by the same current formation owner;
        // the receipt's replay time must not replace the source observation.
        if (fixture.localMatch === undefined) {
          const extracted = await extractor.extract({ systemPrompt: "local", userPrompt: "local" });
          const replay = auditOfficialApiSignalFormation({ raw_json: extracted.rawJson,
            turn_content: fixture.source, ...context,
            created_at: "2030-01-01T00:00:00.000Z", signal_id_for: () => signalId });
          expect(replay.entries[0]?.signal?.raw_payload).toEqual(signal?.raw_payload);
        }
      }
      database.close();
      database = initDatabase({ filename });
      const reopenedMemories = new SqliteMemoryEntryRepo(database);
      const reopenedEvidence = new SqliteEvidenceCapsuleRepo(database);
      for (const saved of persisted) {
        const fixture = saved.fixture;
        const memory = await reopenedMemories.findById(saved.memoryId);
        expect(memory?.content).toBe(fixture.source);
        expect(memory?.event_time_start ?? null).toBe(fixture.eventStart);
        expect(memory?.event_time_end ?? null).toBe(fixture.eventEnd);
        expect(memory?.valid_from ?? null).toBe(fixture.validStart);
        expect(memory?.valid_to ?? null).toBe(fixture.validEnd ?? null);
        const evidence = await reopenedEvidence.findById(saved.evidenceId);
        expect(evidence?.excerpt).toContain(fixture.source);
        expect(evidence?.event_anchor?.occurred_at).toBe("2023-12-31T10:30:00.000Z");
        expect(memory?.created_at).toBe(CREATED_AT);
      }
      for (const saved of deferred) {
        const signal = await new SqliteSignalRepo(database).getById(saved.signalId);
        expect(signal?.signal_state).toBe("deferred");
        expect(signal?.raw_payload.full_turn_content).toContain(saved.source);
        expect(signal?.raw_payload.temporal_projection).toBeUndefined();
        expect(signal?.source_observation?.observed_at).toBe("2023-12-31T10:30:00.000Z");
        expect(new SqliteSourceGroundingDeferQueueRepo(database).get("workspace-1", saved.signalId)).not.toBeNull();
      }
      expect(database.connection.prepare("SELECT count(*) AS count FROM memory_entries").get()).toEqual({ count: persisted.length });
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
