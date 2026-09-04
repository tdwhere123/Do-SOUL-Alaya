import { describe, expect, it } from "vitest";
import {
  freezeLexicalBoundProducerReceipt,
  freezeLexicalBoundProof,
  sealLexicalBoundProof,
  verifyLexicalBoundProof
} from "../../../../recall/runtime/diagnostics/lexical-bound-proof.js";
import { truncatedReceipt } from "./lexical-bound-proof-fixture.js";
import {
  matchingUniverses,
  receiptWithUniverses,
  universeWitness
} from "./lexical-lane-universe-fixture.js";

describe("lexical lane evaluated-universe freeze", () => {
  it("retains per-lane witnesses without sealing a snapshot or legal bound", () => {
    const proof = freezeLexicalBoundProof(matchingUniverses(truncatedReceipt(), {
      porter: ["p1", "p2", "p3"]
    }));
    if (proof === undefined || proof.status !== "captured") {
      throw new Error("expected captured proof");
    }
    expect(proof.receipt.lanes.find((lane) => lane.lane_id === "porter")
      ?.evaluated_universe?.candidate_keys).toEqual(["p1", "p2", "p3"]);
    expect(proof.evaluated_universe).toEqual({
      status: "unavailable",
      reason: "candidate_universe_not_proved"
    });
    expect(proof.identity.snapshot_digest).toEqual({
      status: "unavailable",
      reason: "snapshot_not_sealed"
    });
    verifyLexicalBoundProof(proof);
  });

  it("accepts older receipts that omit the universe witness", () => {
    const proof = freezeLexicalBoundProof(truncatedReceipt());
    if (proof === undefined || proof.status !== "captured") {
      throw new Error("expected captured proof");
    }
    expect(proof.receipt.lanes.every((lane) => lane.evaluated_universe === undefined)).toBe(true);
    expect(proof.evaluated_universe.reason).toBe("candidate_universe_not_proved");
  });

  it("rejects duplicate, unsorted, count, and digest tampering", () => {
    const receipt = matchingUniverses(truncatedReceipt());
    const porter = universeWitness({ laneId: "porter", candidateKeys: ["a", "b"] });
    expect(() => freezeLexicalBoundProducerReceipt(receiptWithUniverses(receipt, (lane) =>
      lane.lane_id === "porter"
        ? { ...porter, candidate_keys: ["b", "a"], count: 2 }
        : lane.evaluated_universe
    ))).toThrow(/sorted unique/i);
    expect(() => freezeLexicalBoundProducerReceipt(receiptWithUniverses(receipt, (lane) =>
      lane.lane_id === "porter"
        ? { ...porter, candidate_keys: ["a", "a"], count: 2 }
        : lane.evaluated_universe
    ))).toThrow(/sorted unique/i);
    expect(() => freezeLexicalBoundProducerReceipt(receiptWithUniverses(receipt, (lane) =>
      lane.lane_id === "porter"
        ? { ...porter, count: 9 }
        : lane.evaluated_universe
    ))).toThrow(/count/i);
    expect(() => freezeLexicalBoundProducerReceipt(receiptWithUniverses(receipt, (lane) =>
      lane.lane_id === "porter"
        ? { ...porter, universe_digest: `sha256:${"0".repeat(64)}` }
        : lane.evaluated_universe
    ))).toThrow(/digest/i);
  });

  it("rejects wrong lane, index kind, scope, and mixed lane sets", () => {
    const receipt = matchingUniverses(truncatedReceipt());
    expect(() => freezeLexicalBoundProducerReceipt(receiptWithUniverses(receipt, (lane) =>
      lane.lane_id === "exact"
        ? universeWitness({ laneId: "porter" })
        : lane.evaluated_universe
    ))).toThrow(/invalid|lane/i);
    expect(() => freezeLexicalBoundProducerReceipt(receiptWithUniverses(receipt, (lane) =>
      lane.lane_id === "exact"
        ? { ...universeWitness({ laneId: "exact" }), index_kind: "memory_content_fts" }
        : lane.evaluated_universe
    ))).toThrow(/invalid|index/i);
    expect(() => freezeLexicalBoundProducerReceipt(receiptWithUniverses(truncatedReceipt(), (lane) =>
      lane.lane_id === "porter" ? universeWitness({ laneId: "porter" }) : undefined
    ))).toThrow(/incomplete/i);
    expect(() => freezeLexicalBoundProducerReceipt(receiptWithUniverses(receipt, (lane) =>
      universeWitness({
        laneId: lane.lane_id,
        candidateKeys: lane.rows.map((row) => row.candidate_key),
        workspaceId: lane.lane_id === "porter" ? "workspace-2" : "workspace-1"
      })
    ))).toThrow(/workspace/i);
    expect(() => freezeLexicalBoundProducerReceipt(receiptWithUniverses(receipt, (lane) =>
      universeWitness({
        laneId: lane.lane_id,
        candidateKeys: lane.rows.map((row) => row.candidate_key),
        objectIds: lane.lane_id === "porter" ? ["a"] : ["b"]
      })
    ))).toThrow(/object_ids/i);
  });

  it("accepts per-lane effective tier when objectIds are applied", () => {
    const receipt = receiptWithUniverses(truncatedReceipt(), (lane) =>
      universeWitness({
        laneId: lane.lane_id,
        candidateKeys: lane.rows.map((row) => row.candidate_key),
        objectIds: ["a"],
        tier: lane.lane_id === "porter" || lane.lane_id === "trigram" ? null : "hot"
      })
    );
    const frozenReceipt = freezeLexicalBoundProducerReceipt(receipt);
    if (frozenReceipt === undefined) throw new Error("expected frozen lexical receipt");
    const porterLane = frozenReceipt.lanes.find((lane) =>
      lane.lane_id === "porter"
    );
    expect(porterLane?.evaluated_universe?.scope?.tier ?? null).toBeNull();
    expect(() => freezeLexicalBoundProducerReceipt(receiptWithUniverses(truncatedReceipt(), (lane) =>
      universeWitness({
        laneId: lane.lane_id,
        candidateKeys: lane.rows.map((row) => row.candidate_key),
        objectIds: ["a"],
        tier: "hot"
      })
    ))).toThrow(/drop tier/i);
  });

  it("rejects an observed row outside the applicable universe", () => {
    const receipt = matchingUniverses(truncatedReceipt());
    expect(() => freezeLexicalBoundProducerReceipt(receiptWithUniverses(receipt, (lane) =>
      lane.lane_id === "porter"
        ? universeWitness({ laneId: "porter", candidateKeys: ["p2", "p3"] })
        : lane.evaluated_universe
    ))).toThrow(/not in the applicable universe/i);
  });

  it("rejects evidence-capsule index kinds and no_tokens_routed known-empty pretence", () => {
    const receipt = matchingUniverses(truncatedReceipt());
    expect(() => freezeLexicalBoundProducerReceipt(receiptWithUniverses(receipt, (lane) =>
      lane.lane_id === "porter"
        ? {
            ...universeWitness({ laneId: "porter" }),
            index_kind: "evidence_capsule_fts" as never
          }
        : lane.evaluated_universe
    ))).toThrow(/invalid|index/i);
    expect(() => freezeLexicalBoundProducerReceipt(receiptWithUniverses(receipt, (lane) => {
      const seeded = universeWitness({ laneId: lane.lane_id, candidateKeys: ["sneaky"] });
      return Object.freeze({
        ...seeded,
        tokens_routed: false,
        applicability: Object.freeze({
          applicable: false as const,
          reason: "no_tokens_routed" as const
        })
      });
    }))).toThrow(/empty|tokens/i);
    expect(() => freezeLexicalBoundProducerReceipt(receiptWithUniverses(receipt, (lane) => {
      const sealed = universeWitness({ laneId: lane.lane_id, tokensRouted: true });
      return { ...sealed, tokens_routed: true, applicability: {
        applicable: false,
        reason: "no_tokens_routed"
      } };
    }))).toThrow(/routed token/i);
  });

  it("checks sealed workspace identity against the witness scope", () => {
    const proof = freezeLexicalBoundProof(matchingUniverses(truncatedReceipt()));
    if (proof === undefined || proof.status !== "captured") {
      throw new Error("expected captured proof");
    }
    expect(() => sealLexicalBoundProof(proof, { workspace_id: "workspace-2" }))
      .toThrow(/workspace/i);
    const sealed = sealLexicalBoundProof(proof, { workspace_id: "workspace-1" });
    if (sealed.status !== "captured") throw new Error("expected captured proof");
    expect(sealed.identity.workspace_id).toBe("workspace-1");
    expect(sealed.identity.snapshot_digest).toEqual({
      status: "unavailable",
      reason: "snapshot_not_sealed"
    });
  });

  it("round-trips a captured witness through JSON archive freeze", () => {
    const original = freezeLexicalBoundProof(matchingUniverses(truncatedReceipt(), {
      exact: ["a"],
      porter: ["a", "b"]
    }));
    const archived = freezeLexicalBoundProof(JSON.parse(JSON.stringify(original)));
    expect(archived).toEqual(original);
    if (archived === undefined) throw new Error("expected archived proof");
    verifyLexicalBoundProof(archived);
  });
});
