import { describe, expect, it } from "vitest";
import {
  buildLongMemEvalSidecarKey,
  deriveLongMemEvalGoldEvidenceIds,
  deriveLongMemEvalGoldMemoryIds,
  deriveLongMemEvalGoldObjectIds,
  isLongMemEvalGoldEligibleResult,
  scoreLongMemEvalRecallHits,
  type LongMemEvalSidecarEntry
} from "../../../datasets/longmemeval/runner/runner-scoring.js";
import {
  buildGoldUsageReport,
  collectDeliveredGoldObjectIdentities
} from "../../../runs/qa/question-recall-support.js";

function sidecar(
  entries: readonly LongMemEvalSidecarEntry[]
): ReadonlyMap<string, LongMemEvalSidecarEntry> {
  return new Map(entries.map((entry) => [
    buildLongMemEvalSidecarKey(entry.objectKind, entry.objectId),
    entry
  ]));
}

describe("LongMemEval source evidence scoring", () => {
  it("keeps memory and evidence gold identities separate while Any@K scores their union", () => {
    const entries = sidecar([
      {
        objectId: "memory-gold",
        objectKind: "memory_entry",
        sessionId: "answer-session",
        hasAnswer: true,
        sourceRounds: [{
          sessionIndex: 0,
          roundIndex: 0,
          sessionId: "answer-session",
          hasAnswer: true
        }]
      },
      {
        objectId: "evidence-gold",
        objectKind: "evidence_capsule",
        sessionId: "answer-session",
        hasAnswer: true,
        sourceRounds: [{
          sessionIndex: 0,
          roundIndex: 1,
          sessionId: "answer-session",
          hasAnswer: true
        }]
      }
    ]);
    const answerSessions = new Set(["answer-session"]);

    expect(deriveLongMemEvalGoldMemoryIds(entries, answerSessions)).toEqual([
      "memory-gold"
    ]);
    expect(deriveLongMemEvalGoldEvidenceIds(entries, answerSessions)).toEqual([
      "evidence-gold"
    ]);
    expect(deriveLongMemEvalGoldObjectIds(entries, answerSessions)).toEqual([
      "memory-gold",
      "evidence-gold"
    ]);
    expect(scoreLongMemEvalRecallHits({
      results: [{
        object_id: "evidence-gold",
        object_kind: "evidence_capsule",
        relevance_score: 0.9
      }],
      sidecar: entries,
      answerSessionIds: answerSessions
    })).toMatchObject({ hitAt1: true, hitAt5: true, hitAt10: true });
  });

  it("does not count evidence from a non-answer source round", () => {
    const entries = sidecar([{
      objectId: "evidence-decoy",
      objectKind: "evidence_capsule",
      sessionId: "other-session",
      hasAnswer: false,
      sourceRounds: [{
        sessionIndex: 1,
        roundIndex: 0,
        sessionId: "other-session",
        hasAnswer: false
      }]
    }]);

    expect(scoreLongMemEvalRecallHits({
      results: [{
        object_id: "evidence-decoy",
        object_kind: "evidence_capsule",
        relevance_score: 0.95
      }],
      sidecar: entries,
      answerSessionIds: new Set(["answer-session"])
    })).toMatchObject({ hitAt1: false, hitAt5: false, hitAt10: false });
  });

  it("keeps reporting identity kind-aware when memory and evidence IDs collide", () => {
    const entries = sidecar([
      {
        objectId: "shared-id",
        objectKind: "memory_entry",
        sessionId: "other-session",
        hasAnswer: false
      },
      {
        objectId: "shared-id",
        objectKind: "evidence_capsule",
        sessionId: "answer-session",
        hasAnswer: true
      }
    ]);
    const results = [
      { object_id: "shared-id", object_kind: "memory_entry" },
      { object_id: "shared-id", object_kind: "evidence_capsule" },
      { object_id: "shared-id", object_kind: "synthesis_capsule" }
    ];
    const identities = collectDeliveredGoldObjectIdentities({
      results,
      sidecar: entries,
      answerSessionIds: new Set(["answer-session"])
    });

    expect(isLongMemEvalGoldEligibleResult(results[0]!)).toBe(true);
    expect(isLongMemEvalGoldEligibleResult(results[1]!)).toBe(true);
    expect(isLongMemEvalGoldEligibleResult(results[2]!)).toBe(false);
    expect(identities).toEqual([{
      objectId: "shared-id",
      objectKind: "evidence_capsule"
    }]);

    const report = buildGoldUsageReport({
      deliveryId: "delivery-evidence",
      results,
      usedGoldObjectIdentities: identities,
      turnIndex: 1,
      questionText: "What did the source say?",
      successReason: "evidence delivered",
      failureReason: "evidence absent"
    });
    expect(report.usedObjectIds).toEqual(["shared-id"]);
    expect(report.deliveredObjects?.map((object) => object.usageStatus)).toEqual([
      "skipped",
      "used",
      "skipped"
    ]);
  });
});
