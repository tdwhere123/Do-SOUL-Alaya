import { describe, expect, it } from "vitest";
import {
  MIXED_KIND_FIRST_EXPOSURE_CONTRACT, PROOF_CONDITIONED_FIRST_EXPOSURE_CONTRACT,
  SOURCE_BEARING_UNION_CONTROLS, SOURCE_BEARING_UNION_FIRST_EXPOSURE_CONTRACT,
  SourceGoldUnitSchema, scoreMixedKindFirstExposure, scoreProofConditionedFirstExposure,
  scoreSourceBearingUnionFirstExposure, sourceGoldUnitFromPublishedRoot
} from "../../../runs/measurement/source-gold-join.js";

const DIGEST = `sha256:${"ab".repeat(32)}`;
const GOLD_TARGET = {
  kind: "source_evidence" as const, workspace_id: "ws", root_kind: "source_record" as const,
  root_id: "gold", source_version: "1", content_digest: DIGEST, evidence_object_id: null
};
const OTHER_TARGET = { ...GOLD_TARGET, root_id: "other" };
const GOLD = sourceGoldUnitFromPublishedRoot(GOLD_TARGET);

function slot(offset: number, kind: "source_evidence" | "semantic_proof", target = GOLD_TARGET) {
  return { rank: offset + 1, object_kind: kind, target };
}

function admit(validated: number[] = [], unverified: number[] = []) {
  return { status: "admitted" as const, validatedRanks: new Set(validated), unverifiedGoldRanks: new Set(unverified) };
}

describe("source-bearing union first exposure", () => {
  it("hits from a validated proof alone and keeps a source hit when proof admission fails", () => {
    const proofOnly = [slot(0, "semantic_proof")];
    const union = scoreSourceBearingUnionFirstExposure(proofOnly, [GOLD], admit([1]));
    expect(scoreMixedKindFirstExposure(proofOnly, [GOLD]).any_at_5).toEqual({ status: "miss", value: false });
    expect(union.any_at_5).toEqual({ status: "hit", value: true });
    const validatedAndOther = [slot(0, "semantic_proof"), slot(1, "semantic_proof", OTHER_TARGET)];
    expect(scoreSourceBearingUnionFirstExposure(validatedAndOther, [GOLD], admit([1])).any_at_5)
      .toEqual({ status: "hit", value: true });
    expect(scoreSourceBearingUnionFirstExposure([slot(0, "semantic_proof", OTHER_TARGET)], [GOLD], admit()).any_at_5)
      .toEqual({ status: "miss", value: false });
    const sourceAndUnverified = [slot(0, "source_evidence"), slot(1, "semantic_proof")];
    const kept = scoreSourceBearingUnionFirstExposure(sourceAndUnverified, [GOLD], admit([], [2]));
    expect(kept.any_at_5).toEqual({ status: "hit", value: true });
    expect(kept.joined_unit_count).toBe(1);
    expect(scoreSourceBearingUnionFirstExposure(proofOnly, [GOLD], admit([], [1])).any_at_5)
      .toEqual({ status: "unavailable", value: null, reason: "delivered gold proof has not been verified" });
  });

  it("rejects a root-identity mismatch and does not let an object id replace it", () => {
    const wrongDigest = { ...GOLD_TARGET, content_digest: `sha256:${"cd".repeat(32)}` };
    const spanned = SourceGoldUnitSchema.parse({
      ...GOLD, span: {
        content_start: 0, content_end: 4, retained_extent: "excerpt",
        content_complete: false, original_complete: false
      }
    });
    expect(scoreSourceBearingUnionFirstExposure([slot(0, "source_evidence", wrongDigest)], [GOLD], admit()).any_at_5)
      .toEqual({ status: "miss", value: false });
    expect(scoreSourceBearingUnionFirstExposure(
      [{ rank: 1, object_kind: "source_evidence", object_id: "gold", target: OTHER_TARGET }],
      [GOLD], admit()
    ).any_at_5).toEqual({ status: "miss", value: false });
    expect(scoreSourceBearingUnionFirstExposure([slot(0, "source_evidence")], [spanned], admit()).any_at_5)
      .toEqual({ status: "miss", value: false });
    expect(SOURCE_BEARING_UNION_CONTROLS.map((row) => row.finding)).toEqual([
      "unvalidated-proof-declaration", "validated-proof-without-source-slot", "memory-id-for-root",
      "digest-or-span-mismatch", "source-and-proof-same-root", "support-or-coverage-text",
      "complete-answer-request", "session-deduped-list", "per-kind-top-five", "abstention", "missing-measurement"
    ]);
  });

  it("counts one query hit when source evidence and a validated proof name the same root", () => {
    const both = [slot(0, "source_evidence"), slot(1, "semantic_proof")];
    const mixed = scoreMixedKindFirstExposure(both, [GOLD]);
    const proof = scoreProofConditionedFirstExposure(both, [GOLD], new Set([2]));
    const union = scoreSourceBearingUnionFirstExposure(both, [GOLD], admit([2]));
    expect(mixed.any_at_5).toEqual({ status: "hit", value: true });
    expect(proof.any_at_5).toEqual({ status: "hit", value: true });
    expect(union.any_at_5).toEqual({ status: "hit", value: true });
    expect(union.joined_unit_count).toBe(1);
    expect(union.contract).toBe(SOURCE_BEARING_UNION_FIRST_EXPOSURE_CONTRACT);
    expect(mixed.contract).toBe(MIXED_KIND_FIRST_EXPOSURE_CONTRACT);
    expect(proof.contract).toBe(PROOF_CONDITIONED_FIRST_EXPOSURE_CONTRACT);
    const second = sourceGoldUnitFromPublishedRoot(OTHER_TARGET);
    const split = scoreSourceBearingUnionFirstExposure(
      [slot(0, "source_evidence"), slot(1, "semantic_proof", OTHER_TARGET)],
      [GOLD, second], admit([2])
    );
    expect(split.any_at_5).toEqual({ status: "hit", value: true });
    expect(split.joined_unit_count).toBe(2);
    expect(Number(mixed.any_at_5.value) + Number(proof.any_at_5.value)).toBe(2);
  });

  it("keeps the union hit when the same root slot is upgraded from source evidence to a validated proof", () => {
    const beforeSlots = [slot(0, "source_evidence")];
    const before = scoreSourceBearingUnionFirstExposure(beforeSlots, [GOLD], admit());
    expect(scoreMixedKindFirstExposure(beforeSlots, [GOLD]).any_at_5).toEqual({ status: "hit", value: true });
    expect(before.any_at_5).toEqual({ status: "hit", value: true });
    const upgraded = [slot(0, "semantic_proof")];
    const after = scoreSourceBearingUnionFirstExposure(upgraded, [GOLD], admit([1]));
    expect(scoreMixedKindFirstExposure(upgraded, [GOLD]).any_at_5).toEqual({ status: "miss", value: false });
    expect(scoreProofConditionedFirstExposure(upgraded, [GOLD], new Set([1])).any_at_5)
      .toEqual({ status: "hit", value: true });
    expect(after.any_at_5).toEqual({ status: "hit", value: true });
    expect(after.joined_unit_count).toBe(1);
    expect(after.contract).not.toBe(MIXED_KIND_FIRST_EXPOSURE_CONTRACT);
  });

  it("does not treat a later proof as its own top five", () => {
    const fillers = [0, 1, 2, 3, 4].map((offset) => slot(offset, "source_evidence", OTHER_TARGET));
    const lateProof = slot(5, "semantic_proof");
    const union = scoreSourceBearingUnionFirstExposure([...fillers, lateProof], [GOLD], admit([6]));
    expect(union.any_at_5).toEqual({ status: "miss", value: false });
    expect(union.any_at_10).toEqual({ status: "hit", value: true });
    const unverified = scoreSourceBearingUnionFirstExposure([...fillers, lateProof], [GOLD], admit([], [6]));
    expect(unverified.any_at_5).toEqual({ status: "miss", value: false });
    expect(unverified.any_at_10.status).toBe("unavailable");
    expect(scoreSourceBearingUnionFirstExposure(
      [{ rank: 1, object_kind: "source_evidence", target: GOLD_TARGET }, { rank: 1, object_kind: "source_evidence", target: GOLD_TARGET }],
      [GOLD], admit()
    ).any_at_5.status).toBe("unavailable");
  });

});
