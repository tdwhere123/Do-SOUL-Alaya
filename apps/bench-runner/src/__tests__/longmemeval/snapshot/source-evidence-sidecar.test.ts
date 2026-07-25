import { describe, expect, it } from "vitest";
import { parseSnapshotSidecar } from
  "../../../longmemeval/snapshot/sidecar-validation.js";
import { RECALL_EVAL_SNAPSHOT_MANIFEST_VERSION } from
  "../../../longmemeval/snapshot/materialize.js";

describe("snapshot source evidence sidecar", () => {
  it("round-trips an evidence capsule with source-round provenance", () => {
    const parsed = parseSnapshotSidecar({
      schema_version: RECALL_EVAL_SNAPSHOT_MANIFEST_VERSION,
      variant: "longmemeval_s",
      questions: [{
        questionId: "q-source",
        question: "What did the assistant recommend?",
        questionDate: "2026-07-22T00:00:00.000Z",
        answerSessionIds: ["answer-session"],
        sidecar: [{
          objectId: "evidence-source",
          objectKind: "evidence_capsule",
          sessionId: "answer-session",
          hasAnswer: true,
          sourceRounds: [{
            sessionIndex: 0,
            roundIndex: 0,
            sessionId: "answer-session",
            hasAnswer: true
          }]
        }],
        seedRounds: [{
          sessionIndex: 0,
          roundIndex: 0,
          sessionId: "answer-session",
          contentSha256: "a".repeat(64),
          hasAnswer: true,
          extractionSource: "cache",
          cacheKey: "b".repeat(64),
          rawJsonSha256: "c".repeat(64),
          rawSignalCount: 0,
          draftCount: 0,
          factsProduced: 0,
          parseDropped: 0,
          compileOverflowDropped: 0,
          candidateAbsent: 0,
          materializationDrop: 0,
          memoryObjectIds: [],
          memoryBindings: [],
          directEvidenceBindings: [{
            signalId: "signal-source",
            evidenceId: "evidence-source"
          }]
        }],
        workspaceId: "workspace-source",
        runId: "run-source"
      }]
    }, "source-evidence.sidecar.json", RECALL_EVAL_SNAPSHOT_MANIFEST_VERSION);

    expect(parsed.questions[0]?.sidecar).toEqual([
      expect.objectContaining({
        objectId: "evidence-source",
        objectKind: "evidence_capsule"
      })
    ]);
    expect(parsed.questions[0]?.seedRounds?.[0]?.directEvidenceBindings).toEqual([{
      signalId: "signal-source",
      evidenceId: "evidence-source"
    }]);
  });
});
