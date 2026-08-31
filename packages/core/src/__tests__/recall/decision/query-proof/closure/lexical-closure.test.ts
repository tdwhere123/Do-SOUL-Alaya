import { describe, expect, it } from "vitest";

import { closeLexicalBoundChannel } from
  "../../../../../recall/decision/query-proof/closure/lexical-bound.js";
import { verifyChannelClosureResult } from
  "../../../../../recall/decision/query-proof/closure/verify.js";
import {
  issueLexicalClosureAuthority,
  readLexicalClosureAuthority,
  type LexicalClosureAuthority
} from "../../../../../recall/decision/query-proof/adapters/lexical-bound/source-authority.js";
import {
  D1_REQUEST,
  D1_SNAPSHOT,
  D1_WORKSPACE,
  plantProof
} from "../adapters/lexical-bound/d1-proof-fixture.js";

const QUERY = `sha256:${"1".repeat(64)}` as const;
const PRINCIPAL = `sha256:${"4".repeat(64)}` as const;

describe("source-authoritative lexical-bound closure", () => {
  it("closes only when every applicable lexical lane is exact", () => {
    const proof = plantProof({ lanes: allExactLanes() });
    const authority = lexicalAuthority(proof);
    const result = closeLexicalBoundChannel(authority)!;
    const source = readLexicalClosureAuthority(authority);

    expect(result.status).toBe("exact_closed");
    expect(source.scope.request_digest).toBe(D1_REQUEST);
    expect(source.scope.snapshot_digest).toBe(D1_SNAPSHOT);
    expect(source.scope.workspace_id).toBe(D1_WORKSPACE);
    expect(result.domain_id).toBe("LexDomain:lexical_relaxed");
    expect(result.completeness_refs.length).toBeGreaterThan(1);
    expect(() => verifyChannelClosureResult(result)).not.toThrow();
  });

  it("does not promote one-lane absence or source-unbounded truncation", () => {
    const proof = plantProof({ universes: false });
    expect(closeLexicalBoundChannel(lexicalAuthority(proof, [sensitivity("porter")]))
      ?.status).toBe("uncertified");
  });

  it("does not treat an empty list as exact closure", () => {
    expect(closeLexicalBoundChannel(lexicalAuthority(plantProof()))?.status)
      .toBe("uncertified");
  });

  it("derives a bounded-open effect only from a source lane frontier", () => {
    const proof = plantProof({ lanes: {
      ...allExactLanes(),
      porter: {
        rows: [{ key: "candidate-a", ordinal: 0.5 }],
        limit: 1
      }
    }});
    expect(closeLexicalBoundChannel(lexicalAuthority(proof))?.status)
      .toBe("uncertified");
    const result = closeLexicalBoundChannel(lexicalAuthority(
      plantProof({ lanes: {
        ...allExactLanes(),
        porter: { rows: [{ key: "candidate-a", ordinal: 0.5 }], limit: 1 }
      }}), [sensitivity("porter")]))!;
    expect(result.status).toBe("bounded_open");
    expect(result.remaining_effects).toEqual([expect.objectContaining({
      lower: 0,
      upper: 0.5
    })]);
  });

  it("rejects proof clones, re-signing, and fabricated authority objects", () => {
    const proof = plantProof();
    lexicalAuthority(proof);
    expect(() => lexicalAuthority(proof, [], {
      query_digest: `sha256:${"6".repeat(64)}`
    })).toThrow(/already bound/u);
    expect(() => lexicalAuthority({ ...proof } as never)).toThrow(/source-issued/u);
    expect(closeLexicalBoundChannel(Object.freeze({}) as LexicalClosureAuthority))
      .toBeNull();
  });

  it("does not exact-close a lane with duplicate candidate identities", () => {
    const proof = plantProof({ lanes: { exact: { rows: [
      { key: "candidate-a", ordinal: 1 },
      { key: "candidate-b", ordinal: 0.8 },
      { key: "candidate-a", ordinal: 0.6 }
    ] }}});
    expect(closeLexicalBoundChannel(lexicalAuthority(proof))?.status)
      .toBe("uncertified");
  });

  it("reflects an authorized query change without allowing domain widening", () => {
    const first = closeLexicalBoundChannel(lexicalAuthority(plantProof()))!;
    const second = closeLexicalBoundChannel(lexicalAuthority(plantProof(), [], {
      query_digest: `sha256:${"7".repeat(64)}`
    }))!;
    expect(second.query_digest).not.toBe(first.query_digest);
    expect(second.result_digest).not.toBe(first.result_digest);
    expect(second.domain_id).toBe("LexDomain:lexical_relaxed");
  });
});

function lexicalAuthority(
  proof: ReturnType<typeof plantProof>,
  sensitivities: Parameters<typeof issueLexicalClosureAuthority>[0]["sensitivities"] = [],
  overrides: Partial<Parameters<typeof issueLexicalClosureAuthority>[0]> = {}
) {
  return issueLexicalClosureAuthority({
    proof,
    query_digest: QUERY,
    principal_digest: PRINCIPAL,
    sensitivities,
    ...overrides
  });
}

function sensitivity(lane_id: "porter") {
  return Object.freeze({
    lane_id,
    sensitivity_id: `proposition:${lane_id}`,
    effect: "proposition_bound" as const,
    target: `lexical:${lane_id}`
  });
}

function allExactLanes() {
  return Object.freeze({
    exact: { rows: [{ key: "candidate-a", ordinal: 1 }] },
    porter: { rows: [{ key: "candidate-a", ordinal: 0.9 }] },
    trigram: { rows: [{ key: "candidate-a", ordinal: 0.8 }] },
    object_key_porter: { rows: [{ key: "candidate-a", ordinal: 0.7 }] },
    object_key_trigram: { rows: [{ key: "candidate-a", ordinal: 0.6 }] }
  });
}
