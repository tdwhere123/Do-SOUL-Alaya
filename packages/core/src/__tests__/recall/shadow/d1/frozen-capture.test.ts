import { describe, expect, it } from "vitest";
import {
  parsePointwiseObservation,
  parseSetUtilityInput,
  type ShadowSetUtilityInput
} from "../../../../recall/shadow/index.js";
import {
  applicableChannelsOf,
  replayD1CaptureWalk,
  replayD1FrozenCapture
} from "../../../../recall/shadow/d1/index.js";
import { field, lexicalAt, view } from "../psi-test-support.js";
import { plantProof } from "./d1-proof-fixture.js";

describe("d1 frozen capture adapter", () => {
  it("parses receipt rows and reuses frozen utilities without copying frontiers", () => {
    const proof = plantProof({
      lanes: {
        porter: {
          rows: [{ key: "A", ordinal: 5 }],
          universeKeys: ["A", "B"]
        }
      }
    });
    const utilities = {
      A: plantedUtility("A", { a1: 0.5, a2: 0 }, "gist:A"),
      B: plantedUtility("B", { a1: 0, a2: 0.5 }, "gist:B")
    };
    const observations = field({
      A: view({
        lexical: lexicalAt("not_observed"),
        subject_preference: subjectObserved()
      }),
      B: view({
        lexical: lexicalAt("not_observed"),
        subject_preference: subjectObserved()
      })
    });
    expect(applicableChannelsOf(observations)).toEqual(["lexical", "subject_preference"]);
    const replayed = replayD1FrozenCapture({
      observations_by_candidate_key: observations,
      set_utilities: [utilities.A, utilities.B],
      lexical_bound_proofs: [proof],
      gold_keys: ["A"]
    });
    const direct = replayD1CaptureWalk({
      observations,
      applicableChannels: ["lexical", "subject_preference"],
      proofs: [proof],
      utilities,
      gold_keys: ["A"]
    });
    expect(replayed.kind).toBe("replayed");
    expect(direct.kind).toBe("replayed");
    if (replayed.kind !== "replayed" || direct.kind !== "replayed") return;
    expect(replayed.prefix_sk_5).toEqual(direct.prefix_sk_5);
    expect(replayed.metrics.any_at_5).toBe(true);
    expect(replayed.metrics.receipt_backed_dominance_edges).toBeGreaterThan(0);
    expect(replayed.d1_walk.decisions.every((row) => row.static_frontier_index === null))
      .toBe(true);
    expect(replayed.d1_frontiers.layers[0]?.member_keys).toEqual(["A"]);
  });

  it("does not invent an embedding channel when the field never observed one", () => {
    const observations = field({
      A: view({ lexical: lexicalAt("not_observed") })
    });
    expect(applicableChannelsOf(observations)).toEqual(["lexical"]);
    const replayed = replayD1FrozenCapture({
      observations_by_candidate_key: observations,
      set_utilities: { A: plantedUtility("A") },
      lexical_bound_proofs: [plantProof({
        lanes: { porter: { rows: [{ key: "A", ordinal: 1 }], universeKeys: ["A"] } }
      })],
      gold_keys: ["A"]
    });
    expect(replayed.kind).toBe("replayed");
    if (replayed.kind !== "replayed") return;
    expect(replayed.metrics.any_at_5).toBe(true);
    expect(replayed.prefix_sk_5).toEqual(["A"]);
  });
});

function plantedUtility(
  key: string,
  covers: Readonly<Record<string, number>> = { topic: 0.5 },
  cid?: string
): ShadowSetUtilityInput {
  const entries = Object.entries(covers);
  const cidReceipt = cid === undefined
    ? { status: "unavailable" as const }
    : { status: "available" as const, cid, grounding: "gist" as const };
  return parseSetUtilityInput({
    schema_version: 1,
    candidate_key: key,
    object_key: key,
    obligations: entries.map(([value, strength]) => ({
      key: { kind: "entity", value },
      raw_atom_ids: [`typed:${value}`],
      availability: "available",
      cover: strength,
      evaluated: true
    })),
    matches: entries.map(([value, strength]) => ({
      obligation: { kind: "entity", value },
      raw_atom_id: `typed:${value}`,
      attribution_kind: "typed_query_atom",
      match_strength: strength
    })),
    values: { status: "no_match", values: [] },
    cid: cidReceipt,
    availability: {
      facility: "available",
      values: "no_match",
      evidence_identity: cidReceipt.status
    }
  });
}

function subjectObserved() {
  return parsePointwiseObservation({
    lineage: "subject_preference",
    receipt: "subject.observe.v1",
    correlation: "subject.observe.v1",
    envelope: { state: "observed", value: 1 },
    domain: {
      query_id: "q",
      applicable_component_ids: ["self_reference"],
      component_operator_ids: ["scoreSelfReferenceAlignment"]
    },
    components: [{
      component_id: "self_reference",
      operator_id: "scoreSelfReferenceAlignment",
      authority_state: "evaluated",
      envelope: { state: "observed", value: 1 }
    }]
  });
}
