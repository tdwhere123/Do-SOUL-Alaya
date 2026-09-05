import { describe, expect, it } from "vitest";
import { LexicalBoundProofDiagnosticsSchema } from
  "../../../harness/recall/capture/capture-proof-diagnostics-schema.js";
import {
  capturedProofWithUniverse,
  capturedTruncatedProof,
  laneUniverse,
  sealLexicalProof
} from "./capture-proof-diagnostics-fixture.js";

describe("lexical lane universe diagnostics schema", () => {
  it("parses older artifacts without a universe witness and captured per-lane witnesses", () => {
    expect(LexicalBoundProofDiagnosticsSchema.parse(capturedTruncatedProof())
      .receipt?.lanes[0]).not.toHaveProperty("evaluated_universe");
    const proof = capturedProofWithUniverse();
    expect(LexicalBoundProofDiagnosticsSchema.parse(proof)).toEqual(proof);
    expect(proof.evaluated_universe).toEqual({
      status: "unavailable",
      reason: "candidate_universe_not_proved"
    });
    expect(proof.identity.snapshot_digest).toEqual({
      status: "unavailable",
      reason: "snapshot_not_sealed"
    });
    expect(proof.receipt.lanes[0]?.evaluated_universe?.candidate_keys).toEqual(["p1", "p2"]);
  });

  it("rejects duplicate, unsorted, count, digest, lane, index, and evidence tampering", () => {
    const proof = capturedProofWithUniverse();
    const universe = proof.receipt.lanes[0]!.evaluated_universe!;
    expect(parseWithUniverse({ ...universe, candidate_keys: ["p2", "p1"] }).success).toBe(false);
    expect(parseWithUniverse({ ...universe, candidate_keys: ["p1", "p1"] }).success).toBe(false);
    expect(parseWithUniverse({ ...universe, count: 9 }).success).toBe(false);
    expect(parseWithUniverse({
      ...universe,
      universe_digest: `sha256:${"0".repeat(64)}`
    }).success).toBe(false);
    expect(parseWithUniverse({ ...universe, lane_id: "exact" }).success).toBe(false);
    expect(parseWithUniverse({
      ...universe,
      index_kind: "memory_content_fts"
    }).success).toBe(false);
    expect(parseWithUniverse({
      ...universe,
      index_kind: "evidence_capsule_fts"
    }).success).toBe(false);
    const missingRow = parseWithUniverse(laneUniverse({ candidateKeys: ["p2"] }));
    expect(missingRow.success).toBe(false);
    const unsortedIds = parseWithUniverse(laneUniverse({ objectIds: ["z", "a"] }));
    expect(unsortedIds.success).toBe(false);
    expect(unsortedIds.error?.issues.some((issue) =>
      issue.path.includes("object_ids")
    )).toBe(true);
  });

  it("rejects routed-token mismatch, nonempty no_tokens_routed, and workspace mismatch", () => {
    const proof = capturedProofWithUniverse();
    const universe = proof.receipt.lanes[0]!.evaluated_universe!;
    expect(parseWithUniverse({
      ...universe,
      tokens_routed: true,
      applicability: { applicable: false, reason: "no_tokens_routed" }
    }).success).toBe(false);
    expect(parseWithUniverse({
      ...universe,
      tokens_routed: false,
      applicability: { applicable: false, reason: "no_tokens_routed" },
      candidate_keys: ["p1"],
      count: 1
    }).success).toBe(false);
    const { proof_digest: _digest, ...body } = proof;
    expect(LexicalBoundProofDiagnosticsSchema.safeParse(sealLexicalProof({
      ...body,
      identity: {
        ...body.identity,
        workspace_id: "workspace-2"
      }
    })).success).toBe(false);
    expect(LexicalBoundProofDiagnosticsSchema.parse(sealLexicalProof({
      ...body,
      identity: {
        ...body.identity,
        workspace_id: "workspace-1"
      }
    })).identity.workspace_id).toBe("workspace-1");
  });

  it("rejects incomplete universe sets and inconsistent scope identity", () => {
    const { proof_digest: _digest, ...body } = capturedTruncatedProof();
    const porter = {
      ...body.receipt.lanes[0]!,
      evaluated_universe: laneUniverse()
    };
    const exact = emptyExactLane();
    expect(LexicalBoundProofDiagnosticsSchema.safeParse(sealLexicalProof({
      ...body,
      receipt: { ...body.receipt, lanes: [porter, exact] }
    })).success).toBe(false);
    expect(LexicalBoundProofDiagnosticsSchema.safeParse(sealLexicalProof({
      ...body,
      receipt: {
        ...body.receipt,
        lanes: [
          porter,
          {
            ...exact,
            evaluated_universe: laneUniverse({
              laneId: "exact",
              workspaceId: "workspace-2",
              candidateKeys: []
            })
          }
        ]
      }
    })).success).toBe(false);
    expect(LexicalBoundProofDiagnosticsSchema.parse(sealLexicalProof({
      ...body,
      receipt: {
        ...body.receipt!,
        lanes: [
          {
            ...porter,
            evaluated_universe: laneUniverse({ objectIds: ["a"], candidateKeys: ["p1", "p2"] })
          },
          {
            ...exact,
            evaluated_universe: laneUniverse({
              laneId: "exact",
              objectIds: ["a"],
              candidateKeys: [],
              tier: "hot"
            })
          }
        ]
      }
    })).receipt?.lanes[0]?.evaluated_universe?.scope?.tier).toBeNull();
  });

  it("rejects content-fts universes that stamp tier when objectIds are applied", () => {
    const { proof_digest: _digest, ...body } = capturedTruncatedProof();
    const objectIds = ["a"] as const;
    expect(LexicalBoundProofDiagnosticsSchema.safeParse(sealLexicalProof({
      ...body,
      receipt: {
        ...body.receipt,
        lanes: [
          {
            ...body.receipt.lanes[0]!,
            evaluated_universe: laneUniverse({
              objectIds,
              candidateKeys: ["p1", "p2"],
              tier: "hot"
            })
          },
          {
            ...emptyTrigramLane(),
            evaluated_universe: laneUniverse({
              laneId: "trigram",
              objectIds,
              candidateKeys: [],
              tier: "hot"
            })
          }
        ]
      }
    })).success).toBe(false);
  });

  it("round-trips a captured universe through JSON archive parse", () => {
    const proof = capturedProofWithUniverse();
    expect(LexicalBoundProofDiagnosticsSchema.parse(JSON.parse(JSON.stringify(proof))))
      .toEqual(proof);
    expect(laneUniverse({ tokensRouted: false }).candidate_keys).toEqual([]);
  });
});

function emptyExactLane() {
  return emptyLane("exact", "matched_token_count", 0);
}

function emptyTrigramLane() {
  return emptyLane("trigram", "bm25_raw_rank", 2);
}

function emptyLane(
  laneId: "exact" | "trigram",
  rawKeyKind: "matched_token_count" | "bm25_raw_rank",
  sourcePriority: 0 | 2
) {
  return {
    lane_id: laneId,
    raw_key_kind: rawKeyKind,
    source_priority: sourcePriority,
    applicability_source: "memory_fts_lane" as const,
    list_n: 0,
    requested_limit: 1,
    status: "empty" as const,
    rows: [],
    unseen_upper_bound: 0
  };
}

function parseWithUniverse(universe: unknown) {
  const proof = capturedProofWithUniverse();
  const { proof_digest: _digest, ...body } = proof;
  const [lane] = body.receipt.lanes;
  return LexicalBoundProofDiagnosticsSchema.safeParse(sealLexicalProof({
    ...body,
    receipt: {
      ...body.receipt,
      lanes: [{ ...lane!, evaluated_universe: universe }]
    }
  }));
}
