import { describe, expect, it } from "vitest";

import { closeFiniteFieldChannel } from
  "../../../../../recall/decision/query-proof/closure/finite-field.js";
import { closeRefinementStopCertificate } from
  "../../../../../recall/decision/query-proof/closure/refinement-stop.js";
import {
  createChannelClosureResult,
  createScopedCompletenessReference,
  type ChannelClosureScope
} from "../../../../../recall/decision/query-proof/closure/contract.js";
import {
  createRecallFiniteFieldSeal,
  issueRecallFiniteFieldClosureAuthority,
  readRecallFiniteFieldClosureAuthority,
  type RecallFiniteFieldClosureAuthority
} from "../../../../../recall/field/finite-field-seal.js";

const QUERY = `sha256:${"1".repeat(64)}` as const;
const REQUEST = `sha256:${"2".repeat(64)}` as const;
const SNAPSHOT = `sha256:${"3".repeat(64)}` as const;
const PRINCIPAL = `sha256:${"4".repeat(64)}` as const;

describe("finite-field source-authoritative channel closure", () => {
  it("closes only the source-owned exact eligible universe", () => {
    const authority = finiteAuthority(finiteSeal("complete", 0), {
      eligible_candidate_keys: ["candidate-a", "candidate-absent"]
    });
    const result = closeFiniteFieldChannel(authority)!;
    const source = readRecallFiniteFieldClosureAuthority(authority);

    expect(result.status).toBe("exact_closed");
    expect(result.universe_digest).toBe(source.universe_digest);
    expect(result.completeness_refs[0]?.universe_digest).toBe(result.universe_digest);
    expect(JSON.stringify(result)).not.toContain("candidate-absent");
  });

  it("rejects a freshly re-signed query, principal, or cloned source receipt", () => {
    const seal = finiteSeal("complete", 0);
    finiteAuthority(seal);
    expect(() => finiteAuthority(seal, {
      query_digest: `sha256:${"6".repeat(64)}`
    })).toThrow(/already bound/u);
    expect(() => finiteAuthority(seal, {
      principal_digest: `sha256:${"7".repeat(64)}`
    })).toThrow(/already bound/u);
    expect(() => finiteAuthority({ ...seal } as never)).toThrow(/source-issued/u);
  });

  it("derives truncated bounds from source evidence and keeps unavailable open", () => {
    const bounded = closeFiniteFieldChannel(finiteAuthority(
      finiteSeal("truncated", 0.4), {
        sensitivity: {
          sensitivity_id: "proposition:x",
          effect: "proposition_bound",
          target: "x"
        }
      }))!;
    expect(bounded.status).toBe("bounded_open");
    expect(bounded.remaining_effects).toEqual([expect.objectContaining({
      lower: 0,
      upper: 0.4
    })]);
    expect(closeFiniteFieldChannel(finiteAuthority(
      finiteSeal("truncated", 0.4)))?.status).toBe("uncertified");
    expect(closeFiniteFieldChannel(finiteAuthority(
      finiteSeal("unavailable", null)))?.status).toBe("uncertified");
  });

  it("does not let one source receipt assert contradictory sensitivity bounds", () => {
    const seal = finiteSeal("truncated", 0.4);
    finiteAuthority(seal, { sensitivity: {
      sensitivity_id: "proposition:x", effect: "proposition_bound", target: "x"
    }});
    expect(() => finiteAuthority(seal, { sensitivity: {
      sensitivity_id: "proposition:x", effect: "proposition_bound", target: "y"
    }})).toThrow(/already bound/u);
  });

  it("treats source-declared ineligibility as non-applicable", () => {
    expect(closeFiniteFieldChannel(finiteAuthority(
      finiteSeal("ineligible", null)))?.status).toBe("not_applicable");
  });

  it("does not accept a fabricated refinement-stop authority", () => {
    expect(closeRefinementStopCertificate({} as never)).toBeNull();
  });

  it("fails unauthorized authority mutation while an authorized query is reflected", () => {
    const first = closeFiniteFieldChannel(finiteAuthority(
      finiteSeal("complete", 0)))!;
    expect(closeFiniteFieldChannel(Object.freeze({}) as RecallFiniteFieldClosureAuthority))
      .toBeNull();
    const alternate = closeFiniteFieldChannel(finiteAuthority(
      finiteSeal("complete", 0), {
        query_digest: `sha256:${"8".repeat(64)}`
      }))!;
    expect(alternate.query_digest).not.toBe(first.query_digest);
    expect(alternate.result_digest).not.toBe(first.result_digest);
  });

  it("rejects completeness references for a different universe or domain", () => {
    const authority = finiteAuthority(finiteSeal("complete", 0));
    const result = closeFiniteFieldChannel(authority)!;
    const source = readRecallFiniteFieldClosureAuthority(authority);
    const scope: ChannelClosureScope = Object.freeze({
      query_digest: source.query_digest,
      request_digest: source.request_digest,
      snapshot_digest: source.snapshot_digest,
      principal_digest: source.principal_digest,
      workspace_id: source.workspace_id,
      observer_id: source.observer_id,
      channel_id: source.channel_id,
      domain_id: source.domain_id,
      universe_digest: source.universe_digest,
      sensitivities: source.sensitivities
    });
    expect(() => createScopedCompletenessReference({
      scope,
      source_receipt_digest: readRecallFiniteFieldClosureAuthority(authority)
        .source_channel.channel_digest,
      universe_digest: `sha256:${"9".repeat(64)}`,
      coordinate_id: "membership"
    })).toThrow(/universe/u);
    const ref = result.completeness_refs[0]!;
    expect(() => createChannelClosureResult({
      scope: { ...scope, domain_id: "other-domain" },
      status: "exact_closed",
      completeness_refs: [ref],
      reason: "mismatched-domain"
    })).toThrow(/scope|domain/u);
  });
});

function finiteAuthority(
  seal: ReturnType<typeof finiteSeal>,
  overrides: Partial<Parameters<typeof issueRecallFiniteFieldClosureAuthority>[0]> = {}
) {
  return issueRecallFiniteFieldClosureAuthority({
    seal,
    channel_id: "test-channel",
    query_digest: QUERY,
    request_digest: REQUEST,
    principal_digest: PRINCIPAL,
    workspace_id: "workspace-1",
    observer_id: "finite-field-test-observer",
    domain_id: "memory-object-membership",
    candidate_key_domain: "memory_object_id",
    ...overrides
  });
}

function finiteSeal(
  status: "complete" | "truncated" | "unavailable" | "ineligible",
  unseenUpperBound: number | null
) {
  const observed = status === "complete" || status === "truncated";
  return createRecallFiniteFieldSeal({
    upstream_snapshot_digest: SNAPSHOT,
    channel_catalog: ["test-channel"],
    channels: [{
      channel_id: "test-channel",
      status,
      depth: observed ? 1 : 0,
      observations: observed ? [{
        observation_id: "test:a",
        candidate_key: "candidate-a",
        rank: 1
      }] : [],
      unseen_upper_bound: unseenUpperBound
    }]
  });
}
