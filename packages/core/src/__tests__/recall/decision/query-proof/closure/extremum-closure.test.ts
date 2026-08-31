import { describe, expect, it } from "vitest";

import { closeFiniteFieldChannel } from
  "../../../../../recall/decision/query-proof/closure/finite-field.js";
import { createExtremumClosureWitness } from
  "../../../../../recall/decision/query-proof/closure/extremum.js";
import {
  createRecallFiniteFieldSeal,
  issueRecallFiniteFieldClosureAuthority
} from "../../../../../recall/field/finite-field-seal.js";

const SNAPSHOT = `sha256:${"3".repeat(64)}` as const;

describe("source-authenticated local extremum closure", () => {
  it("proves only a named finite argmax obligation", () => {
    const { authority, closure } = exactClosure([
      { binding_id: "older", lower: 1, upper: 2 },
      { binding_id: "newer", lower: 3, upper: 3 }
    ]);
    const witness = createExtremumClosureWitness({
      authority,
      closure,
      operator: "argmax",
      sensitivity_id: "extremum:time"
    });

    expect(witness).toMatchObject({
      operator: "argmax",
      extremal_binding_ids: ["newer"]
    });
    expect(witness).not.toHaveProperty("decision_stability_seal");
  });

  it("refuses overlapping source intervals and undeclared sensitivities", () => {
    const overlapping = exactClosure([
      { binding_id: "older", lower: 1, upper: 3 },
      { binding_id: "newer", lower: 2, upper: 4 }
    ]);
    expect(createExtremumClosureWitness({
      ...overlapping,
      operator: "argmax",
      sensitivity_id: "extremum:time"
    })).toBeNull();
    expect(createExtremumClosureWitness({
      ...exactClosure([
        { binding_id: "older", lower: 1, upper: 2 },
        { binding_id: "newer", lower: 3, upper: 3 }
      ]),
      operator: "argmax",
      sensitivity_id: "extremum:other"
    })).toBeNull();
  });

  it("requires source intervals to cover the exact eligible universe", () => {
    expect(() => exactClosure([
      { binding_id: "newer", lower: 3, upper: 3 }
    ])).toThrow(/exactly cover/u);
    expect(() => exactClosure([
      { binding_id: "older", lower: 1, upper: 2 },
      { binding_id: "newer", lower: 3, upper: 3 },
      { binding_id: "invented", lower: 4, upper: 4 }
    ])).toThrow(/exactly cover/u);
  });

  it("refuses closure relabeling and malformed operator shapes", () => {
    const pair = exactClosure([
      { binding_id: "older", lower: 1, upper: 2 },
      { binding_id: "newer", lower: 3, upper: 3 }
    ]);
    expect(createExtremumClosureWitness({
      ...pair,
      closure: { ...pair.closure, principal_digest: SNAPSHOT },
      operator: "argmax",
      sensitivity_id: "extremum:time"
    })).toBeNull();
    expect(createExtremumClosureWitness({
      ...pair,
      operator: "ARGMAX" as never,
      sensitivity_id: "extremum:time"
    })).toBeNull();
    expect(createExtremumClosureWitness({
      ...pair,
      operator: "argmax",
      sensitivity_id: "extremum:time",
      tie_set_complete: true
    } as never)).toBeNull();
  });
});

function exactClosure(intervals: readonly Readonly<{
  readonly binding_id: string;
  readonly lower: number;
  readonly upper: number;
}>[]) {
  const seal = createRecallFiniteFieldSeal({
    upstream_snapshot_digest: SNAPSHOT,
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
  const authority = issueRecallFiniteFieldClosureAuthority({
    seal,
    channel_id: "finite-extremum",
    query_digest: `sha256:${"1".repeat(64)}`,
    request_digest: `sha256:${"2".repeat(64)}`,
    principal_digest: `sha256:${"4".repeat(64)}`,
    workspace_id: "workspace-1",
    observer_id: "finite-extremum-observer",
    domain_id: "typed-time",
    candidate_key_domain: "answer_binding_id",
    eligible_candidate_keys: ["older", "newer"],
    sensitivity: {
      sensitivity_id: "extremum:time",
      effect: "extremum_interval",
      target: "event-time"
    },
    extremum_intervals: intervals
  });
  return Object.freeze({ authority, closure: closeFiniteFieldChannel(authority)! });
}
