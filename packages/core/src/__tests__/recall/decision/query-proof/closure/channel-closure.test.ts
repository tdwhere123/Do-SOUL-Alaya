import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createChannelClosureResult,
  createScopedCompletenessReference,
  type ChannelClosureScope
} from "../../../../../recall/decision/query-proof/closure/contract.js";
import { deriveLiveClosureAuthorityBinding } from
  "../../../../../recall/decision/query-proof/closure/live-authority-binding.js";
import { closeFiniteFieldChannel } from
  "../../../../../recall/decision/query-proof/closure/finite-field.js";
import { closeRefinementStopCertificate } from
  "../../../../../recall/decision/query-proof/closure/refinement-stop.js";
import { verifyChannelClosureResult } from
  "../../../../../recall/decision/query-proof/closure/verify.js";
import { createRecallFiniteFieldSeal } from
  "../../../../../recall/field/finite-field-seal.js";
import type { PreparedRecallRequest } from
  "../../../../../recall/runtime/recall-service-runner-types.js";
import {
  authorityFrom,
  cleanup,
  preparedAuthority
} from "../../../integration/shadow/live-receipt-fixtures.js";

const SOURCE = `sha256:${"9".repeat(64)}` as const;
let prepared: PreparedRecallRequest;

beforeAll(async () => {
  prepared = await preparedAuthority();
});

afterAll(() => cleanup(prepared));

describe("live-authority channel closure admission", () => {
  it("does not let an arbitrary finite-field factory exact-close", () => {
    const result = closeFiniteFieldChannel(authorityFrom(prepared), finiteSeal())!;

    expect(result.status).toBe("uncertified");
    expect(result.source_kind).toBe("unverified_finite_field");
    expect(() => verifyChannelClosureResult(result, authorityFrom(prepared)))
      .toThrow(/lacks an admitted live source/u);
  });

  it("rejects a fresh wrong live authority before accepting the real authority", () => {
    const valid = authorityFrom(prepared);
    const wrong = Object.freeze({ ...valid, workspace_id: "workspace-wrong" });

    expect(closeFiniteFieldChannel(wrong, finiteSeal())).toBeNull();
    expect(closeFiniteFieldChannel(valid, finiteSeal())?.status).toBe("uncertified");
  });

  it("captures each top-level live-authority field exactly once before verification", () => {
    const valid = authorityFrom(prepared);
    let workspaceReads = 0;
    const switching = new Proxy({ ...valid }, {
      get(target, property, receiver) {
        if (property === "workspace_id") {
          workspaceReads += 1;
          return workspaceReads === 1 ? valid.workspace_id : "workspace-injected";
        }
        return Reflect.get(target, property, receiver);
      }
    });

    expect(deriveLiveClosureAuthorityBinding(switching)).toMatchObject({
      workspace_id: valid.workspace_id
    });
    expect(workspaceReads).toBe(1);
  });

  it("verifies the same captured nested bytes instead of rereading a getter", () => {
    const valid = authorityFrom(prepared);
    let principalReads = 0;
    const vector = new Proxy({ ...valid.snapshot_vector }, {
      get(target, property, receiver) {
        if (property === "principal") {
          principalReads += 1;
          return principalReads === 1
            ? valid.snapshot_vector.principal
            : "principal-injected";
        }
        return Reflect.get(target, property, receiver);
      }
    });
    const switching = Object.freeze({ ...valid, snapshot_vector: vector });

    expect(deriveLiveClosureAuthorityBinding(switching).workspace_id)
      .toBe(valid.workspace_id);
    expect(principalReads).toBe(1);
  });

  it("keeps hidden state out of principal authority bytes", () => {
    const valid = authorityFrom(prepared);
    const withHidden = (hidden: string) => {
      const vector = { ...valid.snapshot_vector };
      Object.defineProperty(vector, "hidden_state", {
        value: hidden,
        enumerable: false
      });
      return Object.freeze({ ...valid, snapshot_vector: Object.freeze(vector) });
    };

    const first = deriveLiveClosureAuthorityBinding(withHidden("first"));
    const second = deriveLiveClosureAuthorityBinding(withHidden("second"));
    expect(second).toEqual(first);
    expect(() => deriveLiveClosureAuthorityBinding(Object.freeze({
      ...valid,
      snapshot_vector: Object.freeze({
        ...valid.snapshot_vector,
        principal: "unauthorized-principal"
      })
    }))).toThrow();
  });

  it("does not promote complete, capped, or unavailable structural seals", () => {
    expect(closeFiniteFieldChannel(authorityFrom(prepared), finiteSeal("complete", 0))
      ?.status).toBe("uncertified");
    expect(closeFiniteFieldChannel(authorityFrom(prepared), finiteSeal("truncated", 0.4))
      ?.status).toBe("uncertified");
    expect(closeFiniteFieldChannel(authorityFrom(prepared), finiteSeal("unavailable", null))
      ?.status).toBe("uncertified");
  });

  it("rejects structurally self-digested exact closure as proof", () => {
    const scope = liveScope();
    const reference = createScopedCompletenessReference({
      scope,
      source_receipt_digest: SOURCE,
      universe_digest: scope.universe_digest,
      coordinate_id: "membership"
    });
    const planted = createChannelClosureResult({
      scope,
      status: "exact_closed",
      completeness_refs: [reference],
      source_kind: "structural_only",
      source_receipt_digests: [SOURCE],
      reason: "planted_exact"
    });

    expect(() => verifyChannelClosureResult(planted, authorityFrom(prepared)))
      .toThrow(/lacks an admitted live source/u);
  });

  it("requires completeness references to match exact universe and domain", () => {
    const scope = liveScope();
    expect(() => createScopedCompletenessReference({
      scope,
      source_receipt_digest: SOURCE,
      universe_digest: `sha256:${"8".repeat(64)}`,
      coordinate_id: "membership"
    })).toThrow(/universe/u);
    const reference = createScopedCompletenessReference({
      scope,
      source_receipt_digest: SOURCE,
      universe_digest: scope.universe_digest,
      coordinate_id: "membership"
    });
    expect(() => createChannelClosureResult({
      scope: { ...scope, domain_id: "other-domain" },
      status: "exact_closed",
      completeness_refs: [reference],
      reason: "mismatched_domain"
    })).toThrow(/scope|domain/u);
  });

  it("fails closed for fabricated refinement-stop certificates", () => {
    expect(closeRefinementStopCertificate(authorityFrom(prepared), {} as never))
      .toBeNull();
  });

  it("allows only structural channel selection as a negative control", () => {
    expect(closeFiniteFieldChannel(authorityFrom(prepared), finiteSeal(), "missing"))
      .toBeNull();
    expect(closeFiniteFieldChannel(authorityFrom(prepared), finiteSeal(), "finite-test"))
      .toMatchObject({ channel_id: "finite-test", status: "uncertified" });
  });
});

function liveScope(): ChannelClosureScope {
  return Object.freeze({
    ...deriveLiveClosureAuthorityBinding(authorityFrom(prepared)),
    observer_id: "test-observer",
    channel_id: "finite-test",
    domain_id: "test-domain",
    universe_digest: `sha256:${"7".repeat(64)}`
  });
}

function finiteSeal(
  status: "complete" | "truncated" | "unavailable" = "complete",
  unseenUpperBound: number | null = 0
) {
  const observed = status !== "unavailable";
  return createRecallFiniteFieldSeal({
    upstream_snapshot_digest: prepared.snapshotVector.vector_digest,
    channel_catalog: ["finite-test"],
    channels: [{
      channel_id: "finite-test",
      status,
      depth: observed ? 1 : 0,
      observations: observed ? [{
        observation_id: "finite:a",
        candidate_key: "candidate-a",
        rank: 1
      }] : [],
      unseen_upper_bound: unseenUpperBound
    }]
  });
}
