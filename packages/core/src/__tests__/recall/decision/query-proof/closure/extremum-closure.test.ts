import { describe, expect, it } from "vitest";

import {
  bindClosureReceiptScope,
  closeFiniteFieldChannel,
  createExtremumClosureWitness,
  createFiniteClosureUniverseWitness,
  type ChannelClosureScope
} from "../../../../../recall/decision/query-proof/closure/index.js";
import { createRecallFiniteFieldSeal } from
  "../../../../../recall/field/finite-field-seal.js";

const SNAPSHOT = `sha256:${"3".repeat(64)}` as const;

describe("local extremum closure witness", () => {
  it("proves only a named finite argmax obligation", () => {
    const closure = exactClosure();
    const witness = createExtremumClosureWitness({
      closure,
      operator: "argmax",
      sensitivity_id: "extremum:time",
      intervals: [
        { binding_id: "older", lower: 1, upper: 2 },
        { binding_id: "newer", lower: 3, upper: 3 }
      ],
      extremal_binding_ids: ["newer"],
      tie_set_complete: true
    });

    expect(witness).toMatchObject({
      operator: "argmax",
      extremal_binding_ids: ["newer"]
    });
    expect(witness).not.toHaveProperty("decision_stability_seal");
  });

  it.each([
    ["overlapping interval", [{ binding_id: "a", lower: 1, upper: 3 },
      { binding_id: "b", lower: 2, upper: 4 }], ["b"], true],
    ["open tie set", [{ binding_id: "a", lower: 4, upper: 4 }], ["a"], false],
    ["wrong winner", [{ binding_id: "a", lower: 1, upper: 1 },
      { binding_id: "b", lower: 2, upper: 2 }], ["a"], true]
  ] as const)("refuses %s", (_name, intervals, winners, complete) => {
    expect(createExtremumClosureWitness({
      closure: exactClosure(),
      operator: "argmax",
      sensitivity_id: "extremum:time",
      intervals,
      extremal_binding_ids: winners,
      tie_set_complete: complete
    })).toBeNull();
  });

  it("refuses an invalid closure receipt and an unnamed sensitivity", () => {
    const closure = exactClosure();
    const params = {
      operator: "argmax" as const,
      sensitivity_id: "extremum:time",
      intervals: [{ binding_id: "newer", lower: 3, upper: 3 }],
      extremal_binding_ids: ["newer"],
      tie_set_complete: true
    };

    expect(createExtremumClosureWitness({
      ...params,
      closure: { ...closure, result_digest: SNAPSHOT }
    })).toBeNull();
    expect(createExtremumClosureWitness({
      ...params,
      closure,
      sensitivity_id: ""
    })).toBeNull();
  });
});

function exactClosure() {
  const scope = extremumScope();
  const seal = createRecallFiniteFieldSeal({
    upstream_snapshot_digest: SNAPSHOT,
    channel_catalog: ["finite-extremum"],
    channels: [{
      channel_id: "finite-extremum",
      status: "complete",
      depth: 0,
      observations: [],
      unseen_upper_bound: 0
    }]
  });
  const universe = createFiniteClosureUniverseWitness({
    scope,
    source_receipt_digest: seal.channels[0]!.channel_digest,
    candidate_key_domain: "answer_binding_id",
    eligible_candidate_keys: ["older", "newer"]
  });
  return closeFiniteFieldChannel({
    seal,
    scope,
    universe,
    binding: bindClosureReceiptScope({
      scope,
      source_receipt_digest: seal.channels[0]!.channel_digest,
      universe_digest: universe.universe_digest
    })
  });
}

function extremumScope(): ChannelClosureScope {
  return Object.freeze({
    query_digest: `sha256:${"1".repeat(64)}`,
    request_digest: `sha256:${"2".repeat(64)}`,
    snapshot_digest: SNAPSHOT,
    principal_digest: `sha256:${"4".repeat(64)}`,
    workspace_id: "workspace-1",
    observer_id: "finite-extremum-observer",
    channel_id: "finite-extremum",
    domain_id: "typed-time",
    universe_digest: `sha256:${"5".repeat(64)}`,
    sensitivities: Object.freeze([{
      sensitivity_id: "extremum:time",
      effect: "extremum_interval" as const,
      target: "event-time"
    }])
  });
}
