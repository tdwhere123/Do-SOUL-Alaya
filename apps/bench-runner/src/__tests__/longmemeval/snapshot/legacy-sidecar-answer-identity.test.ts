import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { LongMemEvalQuestion } from "../../../longmemeval/ingestion/dataset.js";
import {
  assertLegacySnapshotSidecarIdentity
} from "../../../longmemeval/snapshot/legacy/legacy-substrate.js";
import type {
  LongMemEvalSnapshotSidecarFile
} from "../../../longmemeval/snapshot/materialize.js";

const question = {
  question_id: "question-mixed",
  question_type: "single-session-user",
  question: "Which round carries the answer?",
  answer: "the middle round",
  question_date: "2026-01-02T03:04:05.000Z",
  haystack_session_ids: ["session-mixed", "session-mixed"],
  haystack_dates: ["2026-01-01T00:00:00.000Z", "2025-12-01T00:00:00.000Z"],
  haystack_sessions: [
    [
      { role: "user", content: "Round zero." },
      { role: "assistant", content: "Zero reply." },
      { role: "user", content: "Round one.", has_answer: true },
      { role: "assistant", content: "One reply." },
      { role: "user", content: "Round two." },
      { role: "assistant", content: "Two reply." }
    ],
    [{ role: "user", content: "A repeated source session id." }]
  ],
  answer_session_ids: ["session-mixed"]
} satisfies LongMemEvalQuestion;

const baseSidecar = {
  schema_version: 2,
  variant: "longmemeval_s",
  questions: [{
    questionId: question.question_id,
    question: question.question,
    questionDate: question.question_date,
    answerSessionIds: question.answer_session_ids,
    workspaceId: "workspace-mixed",
    runId: "run-mixed",
    sidecar: [
      memoryEntry("memory-false-before", false),
      memoryEntry("shared-object", true),
      memoryEntry("memory-false-after", false),
      {
        objectId: "shared-object",
        objectKind: "synthesis_capsule" as const,
        sessionId: "session-mixed",
        hasAnswer: true
      }
    ]
  }]
} satisfies LongMemEvalSnapshotSidecarFile;

let root: string;
let dbPath: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "legacy-answer-identity-"));
  dbPath = join(root, "legacy.db");
  createIdentityDatabase(dbPath);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("legacy sidecar answer identity", () => {
  it("accepts exact round markers and a session aggregate synthesis marker", () => {
    expect(() => validate(baseSidecar)).not.toThrow();
  });

  it.each([
    ["true to false", "shared-object", false],
    ["false to true", "memory-false-before", true]
  ])("rejects a mixed-session memory marker drift from %s", (_label, objectId, hasAnswer) => {
    expect(() => validate(withMarker(objectId, hasAnswer)))
      .toThrow(/memory_entry answer marker mismatch/iu);
  });

  it("rejects a synthesis marker that disagrees with the session aggregate", () => {
    expect(() => validate(withMarker("shared-object", false, "synthesis_capsule")))
      .toThrow(/synthesis_capsule answer marker mismatch/iu);
  });

  it("rejects duplicate object-kind identities and multi-round evidence ambiguity", () => {
    const questionSidecar = baseSidecar.questions[0]!;
    expect(() => validate({
      ...baseSidecar,
      questions: [{
        ...questionSidecar,
        sidecar: [...questionSidecar.sidecar, questionSidecar.sidecar[0]!]
      }]
    })).toThrow(/duplicate legacy sidecar object identity/iu);

    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE memory_entries SET evidence_refs = ? WHERE object_id = ?")
      .run(JSON.stringify(["evidence-r0", "evidence-r1"]), "memory-false-before");
    db.close();
    expect(() => validate(baseSidecar)).toThrow(/ambiguous round evidence/iu);
  });
});

function memoryEntry(objectId: string, hasAnswer: boolean) {
  return {
    objectId,
    objectKind: "memory_entry" as const,
    sessionId: "session-mixed",
    hasAnswer
  };
}

function validate(sidecar: LongMemEvalSnapshotSidecarFile): void {
  assertLegacySnapshotSidecarIdentity(dbPath, sidecar, [question]);
}

function withMarker(
  objectId: string,
  hasAnswer: boolean,
  objectKind: "memory_entry" | "synthesis_capsule" = "memory_entry"
): LongMemEvalSnapshotSidecarFile {
  const source = baseSidecar.questions[0]!;
  return {
    ...baseSidecar,
    questions: [{
      ...source,
      sidecar: source.sidecar.map((entry) =>
        entry.objectId === objectId && entry.objectKind === objectKind
          ? { ...entry, hasAnswer }
          : entry
      )
    }]
  };
}

function createIdentityDatabase(path: string): void {
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
  `);
  const insertEvidence = db.prepare(
    "INSERT INTO evidence_capsules VALUES (?, 'evidence_capsule', ?, ?, ?, ?)"
  );
  const insertMemory = db.prepare(
    "INSERT INTO memory_entries VALUES (?, 'memory_entry', ?, ?, ?, ?)"
  );
  for (const [index, memoryId] of [
    "memory-false-before", "shared-object", "memory-false-after"
  ].entries()) {
    const evidenceId = `evidence-r${index}`;
    insertEvidence.run(
      evidenceId,
      "workspace-mixed",
      "run-mixed",
      "session-mixed",
      JSON.stringify({ artifact_ref: `question-mixed-s0-r${index}` })
    );
    insertMemory.run(
      memoryId,
      "workspace-mixed",
      "run-mixed",
      "session-mixed",
      JSON.stringify([evidenceId])
    );
  }
  db.prepare(
    "INSERT INTO synthesis_capsules VALUES (?, 'synthesis_capsule', ?, ?, ?, ?)"
  ).run(
    "shared-object",
    "workspace-mixed",
    "run-mixed",
    "question-mixed-s0",
    JSON.stringify(["evidence-r0", "evidence-r1", "evidence-r2"])
  );
  db.close();
}
