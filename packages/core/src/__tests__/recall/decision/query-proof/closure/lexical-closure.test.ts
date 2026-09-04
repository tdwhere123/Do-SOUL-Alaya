import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeLexicalBoundChannel } from
  "../../../../../recall/decision/query-proof/closure/lexical-bound.js";
import { verifyChannelClosureResult } from
  "../../../../../recall/decision/query-proof/closure/verify.js";
import { readMemoryLexicalIntervalSources } from
  "../../../../../recall/field/retrieval/retrieval-field-source-authority.js";
import { captureVerifiedLiveClosureAuthority } from
  "../../../../../recall/decision/query-proof/closure/live-authority-binding.js";
import type { PreparedRecallRequest } from
  "../../../../../recall/runtime/recall-service-runner-types.js";
import type { LiveQueryProofAuthority } from
  "../../../../../recall/decision/query-proof/live-query-proof-authority.js";
import {
  authorityFrom,
  capturedLexicalPreparedAuthority,
  cleanup
} from "../../../integration/shadow/live-receipt-fixtures.js";
import { plantProof } from "../adapters/lexical-bound/d1-proof-fixture.js";
import { digestRecallFieldIdentity } from
  "../../../../../recall/field/field-identity.js";
import { evaluateAbstractProofKernel } from
  "../../../../../recall/decision/query-proof/proof/abstract/kernel.js";
import { createKernelCase } from "../proof/abstract/proof-fixture.js";
import {
  allLaneProof,
  boundedLexicalAuthority,
  mixedLaneProof,
  withIssuedSource
} from "./live-lexical-source-fixture.js";

let prepared: PreparedRecallRequest;

beforeAll(async () => {
  prepared = await capturedLexicalPreparedAuthority();
});

afterAll(() => cleanup(prepared));

describe("live-source lexical closure", () => {
  it("exact-closes only a live admitted finite lexical universe", async () => {
    const result = await closeIssued(allLaneProof(2));

    expect(result).toMatchObject({
      status: "exact_closed",
      domain_id: "LexDomain:lexical_relaxed",
      source_kind: "live_lexical_interval"
    });
    expect(result?.completeness_refs).toHaveLength(5);
  });

  it("does not promote cap/truncation and exact-closes an evaluated empty universe", async () => {
    expect((await closeIssued(allLaneProof(1)))?.status).toBe("uncertified");
    expect((await closeIssued(plantProof()))?.status).toBe("exact_closed");
  });

  it("does not exact-close when one complete lane has a truncated sibling", async () => {
    const proof = mixedLaneProof();
    expect(proof.receipt.lanes.find((lane) => lane.lane_id === "exact")?.status)
      .toBe("complete");
    expect(proof.receipt.lanes.find((lane) => lane.lane_id === "porter")?.status)
      .toBe("truncated");
    await withIssuedSource(prepared, proof, (authority) => {
      const result = closeLexicalBoundChannel(authority)!;
      expect(result).toMatchObject({
        status: "uncertified",
        reason: "lexical_lane_unbounded_or_unmapped"
      });
      expect(result.status).not.toBe("exact_closed");
      expect(() => verifyChannelClosureResult(result, authority)).not.toThrow();
    });
  });

  it("keeps an issued lexical receipt with bounded source lag uncertified and OPEN", async () => {
    const bounded = boundedLexicalAuthority(prepared);
    await withIssuedSource(bounded, allLaneProof(2), (authority) => {
      const closure = closeLexicalBoundChannel(authority)!;
      expect(closure).toMatchObject({
        status: "uncertified",
        reason: "lexical_source_bounded_lag_has_no_cq_effect_mapping"
      });
      expect(() => verifyChannelClosureResult(closure, authority)).not.toThrow();
      expect(evaluateAbstractProofKernel(createKernelCase(authority, {
        closures: [closure]
      }).input).status).toBe("OPEN");
    });
  });

  it("captures a closure receipt before a caller-owned status switch", async () => {
    const bounded = boundedLexicalAuthority(prepared);
    await withIssuedSource(bounded, allLaneProof(2), (authority) => {
      const closure = closeLexicalBoundChannel(authority)!;
      let statusReads = 0;
      const switching = new Proxy(closure, {
        get(target, property, receiver) {
          if (property === "status") {
            statusReads += 1;
            return statusReads === 1 ? closure.status : "exact_closed";
          }
          return Reflect.get(target, property, receiver);
        }
      });

      expect(() => verifyChannelClosureResult(switching, authority))
        .toThrow(/captured data cannot use proxies/);
    });
  });

  it("rejects an unfrozen lexical source bundle instead of using its live methods", async () => {
    await withIssuedSource(prepared, allLaneProof(2), (authority) => {
      const mutableBundle = { ...authority.lexical_source_bundle! };
      const switched = Object.freeze({
        ...authority,
        lexical_source_bundle: mutableBundle
      });

      expect(closeLexicalBoundChannel(switched)).toBeNull();
    });
  });

  it("closes against captured sources after the live bundle records grow", async () => {
    await withIssuedSource(prepared, allLaneProof(2), async (authority) => {
      const captured = captureVerifiedLiveClosureAuthority(authority);
      expect(captured.lexical_interval_sources).toHaveLength(1);
      const closed = closeLexicalBoundChannel(captured.source_authority);
      expect(closed?.status).toBe("exact_closed");
      await authority.lexical_source_bundle.searchMemoryKeyword({
        variant: "lexical_relaxed",
        queryText: "other",
        limit: 2,
        scope: {}
      });
      expect(readMemoryLexicalIntervalSources(authority.lexical_source_bundle).length)
        .toBeGreaterThan(1);
      expect(captured.lexical_interval_sources).toHaveLength(1);
      expect(closeLexicalBoundChannel(captured.source_authority)?.result_digest)
        .toBe(closed?.result_digest);
    });
  });
  it("does not consume a planted lexical proof without a live source bundle", () => {
    expect(closeLexicalBoundChannel(authorityFrom(prepared))).toBeNull();
  });

  it("rejects source, universe, and principal mutation while real source verifies", async () => {
    await withIssuedSource(prepared, allLaneProof(2), (authority) => {
      const result = closeLexicalBoundChannel(authority)!;
      expect(() => verifyChannelClosureResult(result, authority)).not.toThrow();
      expect(closeLexicalBoundChannel(Object.freeze({
        ...authority,
        workspace_id: "workspace-wrong"
      }))).toBeNull();
      expect(closeLexicalBoundChannel(Object.freeze({
        ...authority,
        snapshot_vector: Object.freeze({
          ...authority.snapshot_vector,
          principal: "principal-wrong"
        })
      }))).toBeNull();
      const plantedUniverse = { ...result,
        universe_digest: `sha256:${"9".repeat(64)}` as `sha256:${string}`
      };
      expect(() => verifyChannelClosureResult(plantedUniverse, authority))
        .toThrow(/digest mismatch|binding mismatch/u);
    });
  });

  it("rejects a verified closure after query_digest mutation", async () => {
    await withIssuedSource(prepared, allLaneProof(2), (authority) => {
      const result = closeLexicalBoundChannel(authority)!;
      expect(result.status).toBe("exact_closed");
      expect(() => verifyChannelClosureResult(result, authority)).not.toThrow();
      const planted = withRecomputedResultDigest({
        ...result,
        query_digest: `sha256:${"1".repeat(64)}` as `sha256:${string}`
      });
      expect(() => verifyChannelClosureResult(planted, authority))
        .toThrow(/digest mismatch|binding mismatch/u);
    });
  });

  it("rejects a verified closure after snapshot_digest mutation", async () => {
    await withIssuedSource(prepared, allLaneProof(2), (authority) => {
      const result = closeLexicalBoundChannel(authority)!;
      expect(result.status).toBe("exact_closed");
      expect(() => verifyChannelClosureResult(result, authority)).not.toThrow();
      const planted = withRecomputedResultDigest({
        ...result,
        snapshot_digest: `sha256:${"2".repeat(64)}` as `sha256:${string}`
      });
      expect(() => verifyChannelClosureResult(planted, authority))
        .toThrow(/digest mismatch|binding mismatch/u);
    });
  });

  it("rejects source receipt clones and request relabeling", async () => {
    await withIssuedSource(prepared, allLaneProof(2), (authority) => {
      const bundle = authority.lexical_source_bundle!;
      const wrongRequest = Object.freeze({
        ...authority,
        expected_lexical_request_pins: authority.expected_lexical_request_pins.map((pin) =>
          Object.freeze({ ...pin, request_digest: `sha256:${"8".repeat(64)}` as `sha256:${string}` }))
      });
      expect(closeLexicalBoundChannel(wrongRequest)).toBeNull();
      expect(closeLexicalBoundChannel(Object.freeze({
        ...authority,
        lexical_source_bundle: Object.freeze({ ...bundle })
      }))).toBeNull();
    });
  });

  it("admits a source from the same one-time authority capture", async () => {
    await withIssuedSource(prepared, allLaneProof(2), (authority) => {
      let workspaceReads = 0;
      const switching = new Proxy({ ...authority }, {
        get(target, property, receiver) {
          if (property === "workspace_id") {
            workspaceReads += 1;
            return workspaceReads === 1 ? authority.workspace_id : "workspace-injected";
          }
          return Reflect.get(target, property, receiver);
        }
      }) as LiveQueryProofAuthority;

      expect(closeLexicalBoundChannel(switching)?.status).toBe("exact_closed");
      expect(workspaceReads).toBe(1);
    });
  });
});

async function closeIssued(proof: ReturnType<typeof plantProof>) {
  return await withIssuedSource(prepared, proof, (authority) =>
    closeLexicalBoundChannel(authority));
}

function withRecomputedResultDigest<T extends { readonly result_digest: string }>(
  result: T
): T {
  const { result_digest: _digest, ...body } = result;
  return { ...body, result_digest: digestRecallFieldIdentity(body) } as T;
}
