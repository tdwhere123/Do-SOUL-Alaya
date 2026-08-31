import { describe, expect, it } from "vitest";

import {
  bindClosureReceiptScope,
  closeLexicalBoundChannel,
  verifyChannelClosureResult,
  type ChannelClosureScope,
  type ChannelRemainingEffect
} from "../../../../../recall/decision/query-proof/closure/index.js";
import { absentLexicalBoundProof } from
  "../../../../../recall/runtime/diagnostics/lexical-bound-proof.js";
import {
  D1_REQUEST,
  D1_SNAPSHOT,
  D1_WORKSPACE,
  plantProof
} from "../adapters/lexical-bound/d1-proof-fixture.js";

const QUERY = `sha256:${"1".repeat(64)}` as const;
const PRINCIPAL = `sha256:${"4".repeat(64)}` as const;
const UNIVERSE = `sha256:${"5".repeat(64)}` as const;

describe("lexical-bound channel closure", () => {
  it("closes only when every applicable lexical lane is exact", () => {
    const proof = plantProof({ lanes: {
      exact: { rows: [{ key: "candidate-a", ordinal: 1 }] }
    }});
    const scope = lexicalScope();
    const result = closeLexicalBoundChannel({
      proof,
      scope,
      binding: bindClosureReceiptScope({
        scope,
        source_receipt_digest: proof.proof_digest,
        universe_digest: UNIVERSE
      })
    });

    expect(result.status).toBe("exact_closed");
    expect(result.completeness_refs.length).toBeGreaterThan(1);
    expect(() => verifyChannelClosureResult(result)).not.toThrow();
  });

  it("does not promote one-lane absence to family closure", () => {
    const proof = plantProof({ lanes: {
      porter: {
        rows: [{ key: "candidate-a", ordinal: 0.5 }],
        limit: 1
      }
    }});
    const scope = lexicalScope();

    expect(closeLexicalBoundChannel({
      proof,
      scope,
      binding: bindClosureReceiptScope({
        scope,
        source_receipt_digest: proof.proof_digest,
        universe_digest: UNIVERSE
      })
    }).status).toBe("uncertified");
  });

  it("keeps truncated lanes bounded only with a legal CQ sensitivity effect", () => {
    const proof = plantProof({ lanes: {
      porter: {
        rows: [{ key: "candidate-a", ordinal: 0.5 }],
        limit: 1
      }
    }});
    const scope = lexicalScope();
    const binding = bindClosureReceiptScope({
      scope,
      source_receipt_digest: proof.proof_digest,
      universe_digest: UNIVERSE
    });

    expect(closeLexicalBoundChannel({ proof, scope, binding }).status)
      .toBe("uncertified");
    expect(closeLexicalBoundChannel({
      proof,
      scope,
      binding,
      bounded_effects_by_lane: { porter: [boundedEffect()] }
    }).status).toBe("bounded_open");
  });

  it("fails closed on unavailable proof or mismatched scope identity", () => {
    const scope = lexicalScope();
    const proof = plantProof();
    const binding = bindClosureReceiptScope({
      scope,
      source_receipt_digest: proof.proof_digest,
      universe_digest: UNIVERSE
    });

    expect(closeLexicalBoundChannel({
      proof: absentLexicalBoundProof(),
      scope,
      binding
    }).status).toBe("uncertified");
    expect(closeLexicalBoundChannel({
      proof,
      scope: { ...scope, principal_digest: `sha256:${"9".repeat(64)}` },
      binding
    }).status).toBe("uncertified");
  });

  it("does not exact-close a lane with non-adjacent duplicate candidate keys", () => {
    const proof = plantProof({ lanes: {
      exact: { rows: [
        { key: "candidate-a", ordinal: 1 },
        { key: "candidate-b", ordinal: 0.8 },
        { key: "candidate-a", ordinal: 0.6 }
      ] }
    }});
    const scope = lexicalScope();

    expect(closeLexicalBoundChannel({
      proof,
      scope,
      binding: bindClosureReceiptScope({
        scope,
        source_receipt_digest: proof.proof_digest,
        universe_digest: UNIVERSE
      })
    }).status).toBe("uncertified");
  });
});

function lexicalScope(): ChannelClosureScope {
  return Object.freeze({
    query_digest: QUERY,
    request_digest: D1_REQUEST,
    snapshot_digest: D1_SNAPSHOT,
    principal_digest: PRINCIPAL,
    workspace_id: D1_WORKSPACE,
    observer_id: "memory-keyword-search",
    channel_id: "lexical_relaxed",
    domain_id: "LexDomain:lexical_relaxed",
    universe_digest: UNIVERSE,
    sensitivities: Object.freeze([{
      sensitivity_id: "proposition:lexical",
      effect: "proposition_bound" as const,
      target: "lexical-match"
    }])
  });
}

function boundedEffect(): ChannelRemainingEffect {
  return Object.freeze({
    effect_id: "proposition:lexical:remaining",
    sensitivity_id: "proposition:lexical",
    effect: "proposition_bound",
    lower: 0,
    upper: 0.5
  });
}
