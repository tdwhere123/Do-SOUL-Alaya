import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createExtremumClosureWitness } from
  "../../../../../recall/decision/query-proof/closure/extremum.js";
import { closeFiniteFieldChannel } from
  "../../../../../recall/decision/query-proof/closure/finite-field.js";
import { createRecallFiniteFieldSeal } from
  "../../../../../recall/field/finite-field-seal.js";
import type { PreparedRecallRequest } from
  "../../../../../recall/runtime/recall-service-runner-types.js";
import {
  authorityFrom,
  cleanup,
  preparedAuthority
} from "../../../integration/shadow/live-receipt-fixtures.js";

let prepared: PreparedRecallRequest;

beforeAll(async () => {
  prepared = await preparedAuthority();
});

afterAll(() => cleanup(prepared));

describe("source-authenticated local extremum closure", () => {
  it("does not mint an extremum witness from an unverified finite field", () => {
    const authority = authorityFrom(prepared);
    const closure = closeFiniteFieldChannel(authority, finiteSeal())!;

    expect(closure.status).toBe("uncertified");
    expect(createExtremumClosureWitness({
      authority,
      closure,
      operator: "argmax",
      sensitivity_id: "extremum:time"
    })).toBeNull();
  });

  it("does not let a caller declare sensitivity or tie completeness", () => {
    const authority = authorityFrom(prepared);
    const closure = closeFiniteFieldChannel(authority, finiteSeal())!;

    expect(createExtremumClosureWitness({
      authority,
      closure,
      operator: "argmax",
      sensitivity_id: "extremum:invented",
      tie_set_complete: true
    } as never)).toBeNull();
  });

  it("rejects a mutated live principal before considering the closure", () => {
    const authority = authorityFrom(prepared);
    const closure = closeFiniteFieldChannel(authority, finiteSeal())!;
    const wrong = Object.freeze({
      ...authority,
      snapshot_vector: Object.freeze({
        ...authority.snapshot_vector,
        principal: "principal-wrong"
      })
    });

    expect(createExtremumClosureWitness({
      authority: wrong,
      closure,
      operator: "argmax",
      sensitivity_id: "extremum:time"
    })).toBeNull();
  });

  it("never exposes a global DecisionStabilitySeal shape", () => {
    const authority = authorityFrom(prepared);
    const closure = closeFiniteFieldChannel(authority, finiteSeal())!;
    const result = createExtremumClosureWitness({
      authority,
      closure,
      operator: "argmin",
      sensitivity_id: "extremum:time"
    });

    expect(result).toBeNull();
    expect(JSON.stringify(closure)).not.toContain("decision_stability_seal");
  });
});

function finiteSeal() {
  return createRecallFiniteFieldSeal({
    upstream_snapshot_digest: prepared.snapshotVector.vector_digest,
    channel_catalog: ["finite-extremum"],
    channels: [{
      channel_id: "finite-extremum",
      status: "complete",
      depth: 2,
      observations: [
        { observation_id: "older", candidate_key: "older", rank: 1 },
        { observation_id: "newer", candidate_key: "newer", rank: 2 }
      ],
      unseen_upper_bound: 0
    }]
  });
}
