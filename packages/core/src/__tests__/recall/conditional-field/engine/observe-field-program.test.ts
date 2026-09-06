import { describe, expect, it } from "vitest";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  type QueryInterpretation,
  type QueryProgram,
  type RelationValidity
} from "@do-soul/alaya-protocol";
import { observeField } from "../../../../recall/runtime/conditional-field-observe.js";
import { type ObserverReaders } from "../../../../recall/conditional-field/observers/observe.js";
import { SNAPSHOT_ID, defaultBudget, defaultView } from "../reference/deployment.fixture.js";

const VALIDITY: RelationValidity = { kind: "open", valid_from: "2026-01-01T00:00:00.000Z" };
const AS_OF = "2026-09-06T00:00:00.000Z";

describe("observeField program-state stepping", () => {
  it("distinguishes epsilon, empty, sequence, reverse, false guard, and incomplete AND", () => {
    const epsilon = observeField(interpretation({ schema_version: 1, kind: "epsilon" }), input());
    expect(grade(epsilon, "seed", "accepting")).toBe(1000);
    expect(grade(epsilon, "end", "accepting")).toBe(0);

    const empty = observeField(interpretation({ schema_version: 1, kind: "empty" }), input());
    expect(empty.seeds).toEqual([]);
    expect(grade(empty, "seed", "accepting")).toBe(0);

    const sequenced = observeField(interpretation({
      schema_version: 1,
      kind: "sequence",
      steps: [relation("alpha", "s", "m"), relation("beta", "m", "e")]
    }), input());
    expect(grade(sequenced, "seed", "seq.0")).toBe(1000);
    expect(grade(sequenced, "seed", "seq.1")).toBe(0);
    expect(grade(sequenced, "seed", "accepting")).toBe(0);
    expect(grade(sequenced, "middle", "seq.1")).toBe(1000);
    expect(grade(sequenced, "middle", "accepting")).toBe(0);
    expect(grade(sequenced, "end", "accepting")).toBe(1000);

    const reversed = observeField(interpretation({
      schema_version: 1,
      kind: "sequence",
      steps: [relation("alpha", "s", "m"), relation("beta", "m", "e")]
    }), input({ reverse: true }));
    expect(grade(reversed, "end", "accepting")).toBe(0);
    expect(grade(reversed, "seed", "seq.0")).toBe(1000);

    const blocked = observeField(interpretation({
      schema_version: 1,
      kind: "sequence",
      steps: [relation("alpha", "s", "m", "false"), relation("beta", "m", "e")]
    }), input());
    expect(grade(blocked, "end", "accepting")).toBe(0);
    expect(grade(blocked, "middle", "seq.1")).toBe(0);

    const incompleteAnd = observeField(interpretation({
      schema_version: 1,
      kind: "hyperedge",
      join: "and",
      premises: [relation("alpha", "s", "m"), relation("gamma", "s", "e")]
    }), input());
    expect(grade(incompleteAnd, "end", "accepting")).toBe(0);
    expect(incompleteAnd.transitions.filter((row) => row.applicable)).toEqual([]);
  });
});

function interpretation(program: QueryProgram): QueryInterpretation {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    query_id: "program-step",
    status: "resolved",
    snapshot_id: SNAPSHOT_ID,
    program,
    view: defaultView(),
    holes: [],
    hypotheses: []
  };
}

function relation(
  kind: string,
  source: string,
  target: string,
  verdict: "true" | "false" | "unresolved" = "unresolved"
): QueryProgram {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    kind: "relation",
    relation_kind: kind,
    source_variable: source,
    target_variable: target,
    guard: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      kind: "query_predicate",
      verdict,
      time_scope: "none"
    }
  };
}

function input(options: { readonly reverse?: boolean } = {}) {
  return {
    workspace_id: "workspace-1",
    query_text: "seed",
    budget: defaultBudget(),
    as_of: AS_OF,
    readers: readers(options.reverse === true)
  };
}

function readers(reverse: boolean): ObserverReaders {
  const forward = [
    { assertionId: "a1", sourceObjectId: "seed", targetObjectId: "middle", predicate: "alpha" },
    { assertionId: "b1", sourceObjectId: "middle", targetObjectId: "end", predicate: "beta" }
  ];
  const edges = reverse
    ? [
      { assertionId: "a1", sourceObjectId: "middle", targetObjectId: "seed", predicate: "alpha" },
      { assertionId: "b1", sourceObjectId: "end", targetObjectId: "middle", predicate: "beta" }
    ]
    : forward;
  return {
    lexical: () => ({
      ids: ["seed"],
      nativeVisits: 1,
      nativeBytes: 1,
      rowsRead: 1,
      bytesRead: 1,
      truncated: false
    }),
    source: (input) => ({
      row: {
        object_id: input.objectId,
        sourceRevision: "rev",
        lifecycle_state: "active",
        scope_class: "project"
      },
      rowsRead: 1,
      bytesRead: 1,
      unavailable: false
    }),
    relation: (input) => {
      const observations = edges
        .filter((edge) => (input.subject === null || edge.sourceObjectId === input.subject)
          && edge.predicate === input.predicate)
        .map((edge) => ({ ...edge, resultObjectId: edge.targetObjectId, validity: VALIDITY, evidenceRefs: ["e1"] }));
      return {
        observations,
        nativeVisits: observations.length,
        nativeBytes: 1,
        rowsRead: observations.length,
        bytesRead: 1,
        truncated: false
      };
    }
  };
}

function grade(
  state: ReturnType<typeof observeField>,
  objectId: string,
  programState: string
): number {
  if (state.binding.kind !== "bound") return 0;
  return state.binding.snapshot.values.find((row) =>
    row.state.object_id === objectId && row.state.program_state === programState
  )?.milligrades ?? 0;
}
