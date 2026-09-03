import { describe, expect, it } from "vitest";
import { OFFICIAL_API_EXTRACTION_ASSERTIONS_PER_BATCH } from "../../../garden/ingestion/official-api/extraction-request.js";
import {
  demultiplexTransportPack,
  planTurnTransportPacks,
  transportPackIdentity,
  unresolvedRetryMembers,
  type PackableAssertion
} from "../../../garden/ingestion/official-api/transport-pack.js";

function assertions(count: number): PackableAssertion[] {
  return Array.from({ length: count }, (_, index) => ({
    semanticKey: `${(index + 1).toString(16).padStart(2, "0")}`.repeat(32),
    assertionId: index + 1,
    text: `I recorded durable detail number ${index + 1}.`
  }));
}

describe("turn-local transport pack", () => {
  it("is deterministic under permutation and keeps reference batch=8", () => {
    const members = assertions(17);
    const reversed = [...members].reverse();
    const reference = planTurnTransportPacks(members, { kind: "reference_batch_8" });
    const permuted = planTurnTransportPacks(reversed, { kind: "reference_batch_8" });
    expect(reference.inventory_digest).toBe(permuted.inventory_digest);
    expect(reference.packs.map((pack) => pack.assertion_ids.length)).toEqual([
      OFFICIAL_API_EXTRACTION_ASSERTIONS_PER_BATCH,
      OFFICIAL_API_EXTRACTION_ASSERTIONS_PER_BATCH,
      1
    ]);
  });

  it("rejects foreign, duplicate, and missing demultiplex entries", () => {
    const plan = planTurnTransportPacks(assertions(2), { kind: "reference_batch_8" });
    const pack = plan.packs[0]!;
    const result = demultiplexTransportPack(pack, [
      { semanticKey: pack.semantic_keys[0] },
      { semanticKey: pack.semantic_keys[0] },
      { semanticKey: "ff".repeat(32) },
      {}
    ]);
    expect(result.admittedKeys).toEqual([]);
    expect(result.rejections.map((rejection) => rejection.reason)).toEqual([
      "duplicate",
      "foreign or out-of-pack",
      "missing identity"
    ]);
    const mismatched = demultiplexTransportPack(pack, [{
      semanticKey: pack.semantic_keys[0],
      assertionId: pack.assertion_ids[1]
    }]);
    expect(mismatched.admittedKeys).toEqual([]);
    expect(mismatched.rejections[0]?.reason).toBe("mismatched identity");
  });

  it("keeps legal A when B is duplicate or a foreign member is present", () => {
    const pack = planTurnTransportPacks(assertions(2), { kind: "reference_batch_8" }).packs[0]!;
    const result = demultiplexTransportPack(pack, [
      { semanticKey: pack.semantic_keys[0], assertionId: pack.assertion_ids[0] },
      { semanticKey: pack.semantic_keys[1], assertionId: pack.assertion_ids[1] },
      { semanticKey: pack.semantic_keys[1], assertionId: pack.assertion_ids[1] },
      { assertionId: 999 }
    ]);
    expect(result.admittedKeys).toEqual([pack.semantic_keys[0]]);
    expect(result.rejections.map((rejection) => rejection.reason)).toEqual([
      "duplicate", "foreign or out-of-pack"
    ]);
  });

  it("splits a pathological oversize assertion instead of retrying the whole turn", () => {
    const huge = [{
      semanticKey: "aa".repeat(32),
      assertionId: 1,
      text: "x".repeat(80_000)
    }, {
      semanticKey: "bb".repeat(32),
      assertionId: 2,
      text: "I like tea."
    }];
    const plan = planTurnTransportPacks(huge, {
      kind: "token_aware",
      maxAssertions: 32,
      maxInputTokens: 100,
      expectedOutputCap: 1500,
      systemPromptChars: 100
    });
    expect(plan.packs).toHaveLength(1);
    expect(plan.packs[0]?.semantic_keys).toEqual([huge[1]?.semanticKey]);
    expect(plan.unpackable).toEqual([{
      semanticKey: huge[0]?.semanticKey,
      assertionId: 1,
      reason: "hard_cap_exceeded"
    }]);
  });

  it("reduces physical packs versus reference batch=8 on a pinned census slice", () => {
    const members = assertions(17);
    const reference = planTurnTransportPacks(members, { kind: "reference_batch_8" });
    const packed = planTurnTransportPacks(members, {
      kind: "token_aware",
      maxAssertions: 32,
      maxInputTokens: 100_000,
      expectedOutputCap: 8_000,
      systemPromptChars: 100
    });
    expect(packed.packs.length).toBeLessThan(reference.packs.length);
  });

  it("does not put pack shape into semantic keys", () => {
    const members = assertions(9);
    const eight = planTurnTransportPacks(members, { kind: "reference_batch_8" });
    const tokenAware = planTurnTransportPacks(members, {
      kind: "token_aware",
      maxAssertions: 32,
      maxInputTokens: 100_000,
      expectedOutputCap: 8_000,
      systemPromptChars: 100
    });
    expect(new Set(eight.packs.flatMap((pack) => pack.semantic_keys))).toEqual(
      new Set(tokenAware.packs.flatMap((pack) => pack.semantic_keys))
    );
  });

  it("retries only unresolved members after a size split", () => {
    const members = assertions(3);
    const retry = unresolvedRetryMembers(members, new Set([members[0]!.semanticKey]));
    expect(retry.map((member) => member.semanticKey)).toEqual([
      members[1]!.semanticKey, members[2]!.semanticKey
    ]);
  });

  it("hashes pack identity through one helper", () => {
    const pack = planTurnTransportPacks(assertions(2), { kind: "reference_batch_8" }).packs[0]!;
    expect(pack.pack_id).toBe(transportPackIdentity(pack.policy_kind, pack.semantic_keys));
  });
});
