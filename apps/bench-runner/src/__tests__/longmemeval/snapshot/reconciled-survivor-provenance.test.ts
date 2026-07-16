import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import {
  computeCacheKey,
  computeExtractionContentClosureSha256,
  computeExtractionKeySetSha256
} from "../../../longmemeval/compile-seed-cache.js";
import type { LongMemEvalQuestion } from "../../../longmemeval/dataset.js";
import {
  EXTRACTION_CACHE_KEY_ALGO,
  EXTRACTION_CACHE_MANIFEST_VERSION,
  type ExtractionCacheManifestV3
} from "../../../longmemeval/extraction-cache-manifest.js";
import type {
  LongMemEvalSnapshotSidecarFile
} from "../../../longmemeval/snapshot.js";
import { assertSnapshotSeedLedgerBinding } from
  "../../../longmemeval/snapshot/seed-ledger-binding.js";
import { assertSnapshotDatasetSubstrateIdentity } from
  "../../../longmemeval/snapshot/substrate-binding.js";
import { buildLongMemEvalQuestionRuntimeIdentity } from
  "../../../longmemeval/selection/question-runtime-identity.js";
import {
  buildSnapshotExtractionAuthority,
  buildSnapshotExtractionSummary
} from "../../../longmemeval/snapshot/extraction-authority.js";

const roots: string[] = [];
const CONTENT = "User: Same fact.";
const DISTILLED_FACT = "Same fact.";
const MODEL = "fixture-model";
const PROFILE = "provider-default-v1" as const;
const CACHE_KEY = computeCacheKey(
  MODEL,
  PROFILE,
  OFFICIAL_API_SYSTEM_PROMPT,
  CONTENT
);
const RAW_SHA = sha256('{"signals":[{}]}');

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

describe("reconciled snapshot survivor provenance", () => {
  it("binds one survivor to every source round while keeping NOOP idempotent", () => {
    const fixture = buildFixture();
    expect(() => assertSnapshotDatasetSubstrateIdentity({
      dbPath: fixture.dbPath,
      sidecar: fixture.sidecar,
      questions: [fixture.question]
    })).not.toThrow();
    expect(() => verifyLedger(fixture)).not.toThrow();
  });

  it("rejects a sidecar that hides one reconciled source round", () => {
    const fixture = buildFixture();
    const snapshotQuestion = fixture.sidecar.questions[0]!;
    const entry = snapshotQuestion.sidecar[0]!;
    const sidecar: LongMemEvalSnapshotSidecarFile = {
      ...fixture.sidecar,
      questions: [{
        ...snapshotQuestion,
        sidecar: [{ ...entry, sourceRounds: entry.sourceRounds?.slice(0, 1) }]
      }]
    };
    expect(() => verifyLedger({ ...fixture, sidecar }))
      .toThrow(/sidecar source closure mismatch/iu);
  });

  it("rejects a reconciled source when its NOOP audit is missing", () => {
    const fixture = buildFixture();
    const db = new DatabaseSync(fixture.dbPath);
    db.prepare("DELETE FROM event_log WHERE caused_by = 'reconciliation_noop'").run();
    db.close();
    expect(() => verifyLedger(fixture)).toThrow(/NOOP proof/iu);
  });

  it("rejects a binding without its unique successful materialization event", () => {
    const fixture = buildFixture();
    const db = new DatabaseSync(fixture.dbPath);
    db.prepare("DELETE FROM event_log WHERE entity_id = 'signal-noop'").run();
    db.close();
    expect(() => verifyLedger(fixture)).toThrow(/materialization event/iu);
  });

  it("rejects a materialization event whose created objects do not bind the survivor", () => {
    const fixture = buildFixture();
    updateEventPayload(fixture.dbPath, "event-noop-materialized", (payload) => ({
      ...payload,
      created_objects: []
    }));
    expect(() => verifyLedger(fixture)).toThrow(/materialization event/iu);
  });

  it("rejects an ADD materialization event that does not bind its evidence", () => {
    const fixture = buildFixture();
    updateEventPayload(fixture.dbPath, "event-add-materialized", (payload) => ({
      ...payload,
      created_objects: [{ object_kind: "memory_entry", object_id: "memory-survivor" }]
    }));
    expect(() => verifyLedger(fixture)).toThrow(/materialization event/iu);
  });

  it.each([
    ["NOOP evidence", "event-noop-materialized", {
      object_kind: "evidence_capsule", object_id: "evidence-injected"
    }],
    ["ADD memory", "event-add-materialized", {
      object_kind: "memory_entry", object_id: "memory-injected"
    }]
  ])("rejects a materialization event with an extra %s object", (
    _label,
    eventId,
    injected
  ) => {
    const fixture = buildFixture();
    updateEventPayload(fixture.dbPath, eventId, (payload) => ({
      ...payload,
      created_objects: [...payload.created_objects as object[], injected]
    }));
    expect(() => verifyLedger(fixture)).toThrow(/materialization event/iu);
  });

  it("rejects duplicate successful materialization events for one binding", () => {
    const fixture = buildFixture();
    const db = new DatabaseSync(fixture.dbPath);
    db.prepare(`
      INSERT INTO event_log
      SELECT 'event-noop-materialized-copy', event_type, entity_type, entity_id,
             workspace_id, run_id, caused_by, payload_json
        FROM event_log WHERE event_id = 'event-noop-materialized'
    `).run();
    db.close();
    expect(() => verifyLedger(fixture)).toThrow(/materialization event/iu);
  });

  it("rejects a NOOP audit whose dropped content differs from the canonical fact", () => {
    const fixture = buildFixture();
    updateEventPayload(fixture.dbPath, "event-noop-audit", (payload) => ({
      ...payload,
      dropped_content: "Different fact."
    }));
    expect(() => verifyLedger(fixture)).toThrow(/NOOP proof/iu);
  });

  it("rejects a NOOP audit without a bounded best similarity", () => {
    const fixture = buildFixture();
    updateEventPayload(fixture.dbPath, "event-noop-audit", (payload) => ({
      ...payload,
      best_similarity: undefined
    }));
    expect(() => verifyLedger(fixture)).toThrow(/NOOP proof/iu);
  });

  it("rejects reordered or duplicate reconciled source rounds", () => {
    const fixture = buildFixture();
    const snapshotQuestion = fixture.sidecar.questions[0]!;
    const entry = snapshotQuestion.sidecar[0]!;
    const sources = entry.sourceRounds!;
    for (const sourceRounds of [[sources[1]!, sources[0]!], [sources[0]!, sources[0]!]]) {
      const sidecar: LongMemEvalSnapshotSidecarFile = {
        ...fixture.sidecar,
        questions: [{
          ...snapshotQuestion,
          sidecar: [{ ...entry, sourceRounds }]
        }]
      };
      expect(() => assertSnapshotDatasetSubstrateIdentity({
        dbPath: fixture.dbPath,
        sidecar,
        questions: [fixture.question]
      })).toThrow(/answer marker|source/iu);
      expect(() => verifyLedger({ ...fixture, sidecar }))
        .toThrow(/source closure|answer marker/iu);
    }
  });
});

function buildFixture() {
  const root = mkdtempSync(join(tmpdir(), "reconciled-survivor-"));
  roots.push(root);
  const dbPath = join(root, "snapshot.db");
  const question = buildQuestion();
  const runtime = buildLongMemEvalQuestionRuntimeIdentity(question.question_id);
  createDatabase(dbPath, runtime);
  const rounds = [
    sourceRound(0, "session-first", false, "signal-add", "evidence-first"),
    sourceRound(1, "session-answer", true, "signal-noop", null)
  ];
  const sidecar: LongMemEvalSnapshotSidecarFile = {
    schema_version: 2,
    variant: "longmemeval_s",
    questions: [{
      questionId: question.question_id,
      question: question.question,
      questionDate: question.question_date,
      answerSessionIds: question.answer_session_ids,
      workspaceId: runtime.workspaceId,
      runId: runtime.runId,
      sidecar: [{
        objectId: "memory-survivor",
        objectKind: "memory_entry",
        sessionId: "session-first",
        hasAnswer: false,
        sourceRounds: rounds.map(({ sessionIndex, roundIndex, sessionId, hasAnswer }) => ({
          sessionIndex, roundIndex, sessionId, hasAnswer
        }))
      }],
      seedRounds: rounds
    }]
  };
  return { dbPath, question, sidecar, extraction: extractionFixture() };
}

function verifyLedger(fixture: ReturnType<typeof buildFixture>): void {
  assertSnapshotSeedLedgerBinding({
    dbPath: fixture.dbPath,
    sidecar: fixture.sidecar,
    questions: [fixture.question],
    extraction: fixture.extraction.compact,
    extractionAuthority: fixture.extraction.authority,
    seedExtractionPath: {
      path: "official_api_compile",
      extraction_attempts: 2,
      cache_hits: 2,
      llm_calls: 0,
      offline_fallbacks: 0,
      live_extraction_failures: 0,
      cached_extraction_failures: 0,
      facts_produced: 2,
      signals_dropped: 0,
      parse_dropped: 0,
      compile_overflow_dropped: 0,
      signals_dropped_by_reason: { candidate_absent: 0, materialization_drop: 0 }
    },
    closureAuthority: {
      kind: "exact",
      questionWindow: { offset: 0, limit: 1 }
    }
  });
}

function sourceRound(
  sessionIndex: number,
  sessionId: string,
  hasAnswer: boolean,
  signalId: string,
  evidenceId: string | null
) {
  return {
    sessionIndex,
    roundIndex: 0,
    sessionId,
    contentSha256: sha256(CONTENT),
    hasAnswer,
    extractionSource: "cache" as const,
    cacheKey: CACHE_KEY,
    rawJsonSha256: RAW_SHA,
    rawSignalCount: 1,
    draftCount: 1,
    factsProduced: 1,
    parseDropped: 0,
    compileOverflowDropped: 0,
    candidateAbsent: 0,
    materializationDrop: 0,
    memoryObjectIds: ["memory-survivor"],
    memoryBindings: [{ objectId: "memory-survivor", signalId, evidenceId }]
  };
}

function buildQuestion(): LongMemEvalQuestion {
  return {
    question_id: "q-reconciled",
    question_type: "single-session-user",
    question: "What fact was stated?",
    answer: "Same fact.",
    question_date: "2026-07-17T00:00:00.000Z",
    haystack_session_ids: ["session-first", "session-answer"],
    haystack_dates: ["2026-07-15T00:00:00.000Z", "2026-07-16T00:00:00.000Z"],
    haystack_sessions: [
      [{ role: "user", content: "Same fact." }],
      [{ role: "user", content: "Same fact.", has_answer: true }]
    ],
    answer_session_ids: ["session-answer"]
  };
}

function createDatabase(
  path: string,
  runtime: ReturnType<typeof buildLongMemEvalQuestionRuntimeIdentity>
): void {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE memory_entries (
      object_id TEXT PRIMARY KEY, object_kind TEXT NOT NULL,
      workspace_id TEXT NOT NULL, run_id TEXT NOT NULL,
      surface_id TEXT, evidence_refs TEXT NOT NULL
    );
    CREATE TABLE evidence_capsules (
      object_id TEXT PRIMARY KEY, object_kind TEXT NOT NULL,
      workspace_id TEXT NOT NULL, run_id TEXT NOT NULL,
      surface_id TEXT, physical_anchor TEXT
    );
    CREATE TABLE synthesis_capsules (
      object_id TEXT PRIMARY KEY, object_kind TEXT NOT NULL,
      workspace_id TEXT NOT NULL, run_id TEXT NOT NULL,
      topic_key TEXT NOT NULL, evidence_refs TEXT NOT NULL
    );
    CREATE TABLE signals (
      signal_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL,
      run_id TEXT NOT NULL, source TEXT NOT NULL, evidence_refs_json TEXT NOT NULL,
      raw_payload_json TEXT NOT NULL
    );
    CREATE TABLE event_log (
      event_id TEXT PRIMARY KEY, event_type TEXT NOT NULL,
      entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL, run_id TEXT,
      caused_by TEXT, payload_json TEXT NOT NULL
    );
  `);
  db.prepare(
    "INSERT INTO evidence_capsules VALUES (?, 'evidence_capsule', ?, ?, ?, ?)"
  ).run(
    "evidence-first",
    runtime.workspaceId,
    runtime.runId,
    "session-first",
    JSON.stringify({ artifact_ref: "q-reconciled-s0-r0" })
  );
  db.prepare(
    "INSERT INTO memory_entries VALUES (?, 'memory_entry', ?, ?, ?, ?)"
  ).run(
    "memory-survivor",
    runtime.workspaceId,
    runtime.runId,
    "session-first",
    JSON.stringify(["evidence-first"])
  );
  const insertSignal = db.prepare("INSERT INTO signals VALUES (?, ?, ?, ?, ?, ?)");
  insertSignal.run(
    "signal-add",
    runtime.workspaceId,
    runtime.runId,
    "garden_compile",
    JSON.stringify(["q-reconciled-s0-r0"]),
    JSON.stringify({ distilled_fact: DISTILLED_FACT })
  );
  insertSignal.run(
    "signal-noop",
    runtime.workspaceId,
    runtime.runId,
    "garden_compile",
    JSON.stringify(["q-reconciled-s1-r0"]),
    JSON.stringify({ distilled_fact: DISTILLED_FACT })
  );
  insertMaterializedEvent(db, runtime, {
    eventId: "event-add-materialized",
    signalId: "signal-add",
    createdObjects: [
      { object_kind: "evidence_capsule", object_id: "evidence-first" },
      { object_kind: "memory_entry", object_id: "memory-survivor" }
    ]
  });
  insertMaterializedEvent(db, runtime, {
    eventId: "event-noop-materialized",
    signalId: "signal-noop",
    createdObjects: [{ object_kind: "memory_entry", object_id: "memory-survivor" }]
  });
  db.prepare("INSERT INTO event_log VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    "event-noop-audit",
    "soul.signal.triaged",
    "candidate_memory_signal",
    "signal-noop:noop_audit",
    runtime.workspaceId,
    runtime.runId,
    "reconciliation_noop",
    JSON.stringify({
      signal_id: "signal-noop",
      workspace_id: runtime.workspaceId,
      run_id: runtime.runId,
      triage_result: "dropped",
      dropped_content: DISTILLED_FACT,
      surviving_object_id: "memory-survivor",
      best_similarity: 1
    })
  );
  db.close();
}

function insertMaterializedEvent(
  db: DatabaseSync,
  runtime: ReturnType<typeof buildLongMemEvalQuestionRuntimeIdentity>,
  input: {
    readonly eventId: string;
    readonly signalId: string;
    readonly createdObjects: readonly { readonly object_kind: string; readonly object_id: string }[];
  }
): void {
  db.prepare("INSERT INTO event_log VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    input.eventId,
    "soul.signal.materialized",
    "candidate_memory_signal",
    input.signalId,
    runtime.workspaceId,
    runtime.runId,
    "materialization_router",
    JSON.stringify({
      signal_id: input.signalId,
      workspace_id: runtime.workspaceId,
      run_id: runtime.runId,
      created_objects: input.createdObjects,
      success: true
    })
  );
}

function updateEventPayload(
  dbPath: string,
  eventId: string,
  mutate: (payload: Record<string, unknown>) => Record<string, unknown>
): void {
  const db = new DatabaseSync(dbPath);
  const row = db.prepare("SELECT payload_json FROM event_log WHERE event_id = ?")
    .get(eventId) as { readonly payload_json: string };
  const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  db.prepare("UPDATE event_log SET payload_json = ? WHERE event_id = ?")
    .run(JSON.stringify(mutate(payload)), eventId);
  db.close();
}

function extractionFixture() {
  const entry = {
    cacheKey: CACHE_KEY,
    model: MODEL,
    requestProfile: PROFILE,
    rawJsonSha256: RAW_SHA,
    rawSignalCount: 1,
    parsedDraftCount: 1
  };
  const manifest: ExtractionCacheManifestV3 = {
    schema_version: EXTRACTION_CACHE_MANIFEST_VERSION,
    extraction_model: MODEL,
    model_family: MODEL,
    request_profile: PROFILE,
    provider_url: "redacted",
    system_prompt_sha256: sha256(OFFICIAL_API_SYSTEM_PROMPT),
    cache_key_algo: EXTRACTION_CACHE_KEY_ALGO,
    dataset: "longmemeval-s",
    dataset_revision: "b".repeat(64),
    requested_turns: 1,
    cached_turns: 1,
    coverage: 1,
    fill_status: "complete",
    window_offset: 0,
    window_limit: 1,
    expected_turns: 1,
    expected_key_set_sha256: computeExtractionKeySetSha256([CACHE_KEY]),
    content_closure_sha256: computeExtractionContentClosureSha256([entry]),
    content_closure_index: { [CACHE_KEY]: [RAW_SHA, 1, 1] },
    storage: "git-tracked",
    built_at: "2026-07-17T00:00:00.000Z",
    builder: "test"
  };
  const sourceManifestSha256 = "a".repeat(64);
  const compact = buildSnapshotExtractionSummary(manifest, sourceManifestSha256);
  return {
    compact,
    authority: buildSnapshotExtractionAuthority(
      manifest,
      sourceManifestSha256,
      compact
    )
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
