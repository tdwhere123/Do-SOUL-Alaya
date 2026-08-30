import { afterEach, describe, expect, it } from "vitest";
import { freezeFieldResult } from
  "../../../../recall/field/retrieval/retrieval-field-validation.js";
import {
  freezeLexicalBoundProducerReceipt,
  freezeLexicalBoundProof,
  sealLexicalBoundProof,
  verifyLexicalBoundProof
} from "../../../../recall/runtime/diagnostics/lexical-bound-proof.js";
import {
  installCoreConfigFromProcessEnv,
  resetCoreConfigForTests
} from "../../../../config/install-core-config.js";
import { buildDefaultPolicy } from "../../../../recall/runtime/orchestration.js";
import { buildLiveObservationField } from
  "../../../../recall/integration/shadow/live-observations.js";
import {
  candidateOf,
  completeReceipt,
  emptySupplementary,
  fieldResult,
  stripLive,
  truncatedReceipt
} from "./lexical-bound-proof-fixture.js";

afterEach(() => resetCoreConfigForTests());

describe("lexical bound proof diagnostics", () => {
  it("round-trips complete and truncated producer rows through freeze", () => {
    const receipt = truncatedReceipt();
    const proof = freezeLexicalBoundProof(receipt);
    if (proof === undefined || proof.status !== "captured") {
      throw new Error("expected captured bound proof");
    }
    const porter = proof.receipt.lanes.find((lane) => lane.lane_id === "porter");
    expect(porter?.rows.map((row) => row.candidate_key)).toEqual(["p1", "p2", "p3"]);
    expect(porter?.requested_limit).toBe(2);
    expect(porter?.status).toBe("truncated");
    expect(porter?.unseen_upper_bound).toBe(0);
    expect(proof.observed_candidate_keys).toEqual(["key-only", "p1", "p2", "p3", "shared"]);
    expect(proof.evaluated_universe).toEqual({
      status: "unavailable",
      reason: "candidate_universe_not_proved"
    });
    const objectKey = proof.receipt.lanes.find((lane) => lane.lane_id === "object_key_trigram");
    expect(objectKey?.rows.map((row) => row.candidate_key)).toEqual(["key-only"]);
    expect(proof.receipt.candidates.find((row) => row.candidate_key === "shared")
      ?.discarded_lane_ids).toEqual(["object_key_porter"]);
    expect(proof.identity.snapshot_digest).toEqual({
      status: "unavailable",
      reason: "snapshot_not_sealed"
    });
    verifyLexicalBoundProof(proof);
  });

  it("keeps live capture stripped while freezeFieldResult preserves the sibling", () => {
    const receipt = truncatedReceipt();
    const frozen = freezeFieldResult(fieldResult(receipt), receipt.merge_limit);
    expect(frozen.lexical_raw_rank?.lanes[0]).not.toHaveProperty("rows");
    expect(frozen.lexical_raw_rank?.lanes[0]).not.toHaveProperty("requested_limit");
    expect(frozen.lexical_raw_rank_receipt?.lanes.find((lane) => lane.lane_id === "porter")?.rows)
      .toEqual(receipt.lanes.find((lane) => lane.lane_id === "porter")?.rows);
  });

  it("does not let the sibling change liveLexical missing_rank", () => {
    installCoreConfigFromProcessEnv();
    const receipt = truncatedReceipt();
    const live = stripLive(receipt);
    const field = buildLiveObservationField({
      candidates: [candidateOf("p3")],
      policy: buildDefaultPolicy({
        strategy: "chat",
        taskSurfaceRef: "lexical-bound-proof",
        now: () => "2026-07-12T00:00:00.000Z",
        generateRuntimeId: () => "11111111-1111-4111-8111-111111111111"
      }),
      supplementaryData: emptySupplementary("stable"),
      memoryLexicalCaptures: [live]
    });
    expect(field["workspace_local:memory_entry:p3"]?.lineages.lexical?.envelope).toEqual({
      state: "not_observed",
      reason: "missing_rank"
    });
  });

  it("does not invent a snapshot identity when seal data is missing", () => {
    const proof = freezeLexicalBoundProof(completeReceipt());
    if (proof === undefined || proof.status !== "captured") {
      throw new Error("expected captured proof");
    }
    const sealed = sealLexicalBoundProof(proof, {});
    if (sealed.status !== "captured") throw new Error("expected captured proof");
    expect(sealed.identity.snapshot_digest).toEqual({
      status: "unavailable",
      reason: "snapshot_not_sealed"
    });
    expect(sealed.identity.request_digest).toEqual({
      status: "unavailable",
      reason: "request_not_sealed"
    });
    expect(sealed.field_prefix).toEqual({
      status: "unavailable",
      reason: "field_prefix_not_sealed"
    });
    expect(sealed.candidate_key_domain).toEqual({
      status: "unavailable",
      reason: "candidate_key_domain_not_sealed"
    });
  });

  it("fails closed on a missing frontier and does not treat hit keys as the universe", () => {
    const receipt = truncatedReceipt();
    const porter = receipt.lanes.find((lane) => lane.lane_id === "porter");
    if (porter === undefined) throw new Error("expected porter lane");
    const { unseen_upper_bound: _dropped, ...withoutFrontier } = porter;
    expect(() => freezeLexicalBoundProducerReceipt({
      ...receipt,
      lanes: receipt.lanes.map((lane) =>
        lane.lane_id === "porter" ? withoutFrontier : lane
      )
    })).toThrow(/frontier|invalid/i);
    const proof = freezeLexicalBoundProof({
      ...freezeLexicalBoundProof(receipt),
      evaluated_universe: ["p1", "p2"]
    });
    if (proof === undefined || proof.status !== "captured") {
      throw new Error("expected captured proof");
    }
    expect(proof.evaluated_universe).toEqual({
      status: "unavailable",
      reason: "candidate_universe_not_proved"
    });
    expect(proof.observed_candidate_keys).toEqual(["key-only", "p1", "p2", "p3", "shared"]);
  });

  it("keeps a truncated frontier only when ranking keys are monotone", () => {
    const receipt = truncatedReceipt();
    const porter = receipt.lanes.find((lane) => lane.lane_id === "porter");
    const shuffled = {
      ...receipt,
      lanes: receipt.lanes.map((lane) => {
        if (lane.lane_id !== "porter" || porter === undefined) return lane;
        const rows = Object.freeze([
          porter.rows[2]!,
          porter.rows[0]!,
          porter.rows[1]!
        ]);
        return Object.freeze({
          ...lane,
          rows,
          unseen_upper_bound: Object.freeze({
            status: "unavailable" as const,
            reason: "producer_order_not_monotone" as const
          })
        });
      })
    };
    const frozen = freezeLexicalBoundProducerReceipt(shuffled);
    expect(frozen?.lanes.find((lane) => lane.lane_id === "porter")?.unseen_upper_bound)
      .toEqual({ status: "unavailable", reason: "producer_order_not_monotone" });
    expect(() => freezeLexicalBoundProducerReceipt({
      ...shuffled,
      lanes: shuffled.lanes.map((lane) =>
        lane.lane_id === "porter"
          ? { ...lane, unseen_upper_bound: lane.rows.at(-1)?.grouped_ordinal }
          : lane
      )
    })).toThrow(/frontier/i);
  });

  it("does not copy diagnostic siblings onto frozen refinements", () => {
    const receipt = truncatedReceipt();
    const frozen = freezeFieldResult({
      ...fieldResult(receipt),
      refinement_levels: Object.freeze([Object.freeze({
        requested_depth: 4,
        ...fieldResult(receipt)
      })])
    }, receipt.merge_limit);
    expect(frozen.lexical_raw_rank_receipt).toBeDefined();
    expect(frozen.refinement_levels?.[0]).not.toHaveProperty("lexical_raw_rank");
    expect(frozen.refinement_levels?.[0]).not.toHaveProperty("lexical_raw_rank_receipt");
  });
});
