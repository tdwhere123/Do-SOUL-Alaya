import { describe, expect, it } from "vitest";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  memoryProductStateKey,
  sourceProductStateKey,
  type QueryInterpretation,
  type QueryProgram,
  type RelationValidity
} from "@do-soul/alaya-protocol";
import {
  adjacencyEffectsForRows,
  seedProgramStates
} from "../../../../recall/conditional-field/engine/path-composition.js";
import { RELATION_MILLIGRADES } from "../../../../recall/runtime/conditional-field-observe.js";
import { defaultView, SNAPSHOT_ID } from "../reference/deployment.fixture.js";

const AS_OF = "2026-09-07T00:00:00.000Z";
const VALIDITY: RelationValidity = { kind: "open", valid_from: "2026-01-01T00:00:00.000Z" };
const DIGEST = `sha256:${"a".repeat(64)}`;
const REL = "observed_log";

describe("seam identity for transitions", () => {
  it("advances A@rev-a onto B@rev-b and never inherits rev-a", () => {
    const program = relation(REL);
    const start = seedProgramStates(program)[0]!;
    const from = memoryProductStateKey({
      workspace_id: "ws",
      object_id: "mem-a",
      source_revision: "rev-a",
      program_state: start,
      hypothesis_id: "h0",
      binding_context: "unbound",
      time_state: "as_of"
    });
    const effects = adjacencyEffectsForRows([edge("mem-a", "mem-b", REL)], {
      interpretation: interpretation(program),
      asOf: AS_OF,
      liveStates: [from],
      overlay: RELATION_MILLIGRADES,
      sourceFacts: new Map([
        ["mem-a", { object_id: "mem-a", source_revision: "rev-a" }],
        ["mem-b", { object_id: "mem-b", source_revision: "rev-b" }]
      ])
    });
    const transition = effects.find((effect) => effect.transition !== undefined)?.transition;
    expect(transition).toBeDefined();
    expect(transition?.to.target).toEqual({
      kind: "memory_entry",
      workspace_id: "ws",
      object_id: "mem-b",
      source_revision: "rev-b"
    });
    expect(transition?.to.target.kind === "memory_entry"
      && transition.to.target.source_revision).not.toBe("rev-a");
  });

  it("does not mint a Transition when B's revision is unobserved", () => {
    const program = relation(REL);
    const start = seedProgramStates(program)[0]!;
    const from = memoryProductStateKey({
      workspace_id: "ws",
      object_id: "mem-a",
      source_revision: "rev-a",
      program_state: start,
      hypothesis_id: "h0",
      binding_context: "unbound",
      time_state: "as_of"
    });
    const effects = adjacencyEffectsForRows([edge("mem-a", "mem-b", REL)], {
      interpretation: interpretation(program),
      asOf: AS_OF,
      liveStates: [from],
      overlay: RELATION_MILLIGRADES
    });
    expect(effects.some((effect) => effect.transition !== undefined)).toBe(false);
    expect(effects.some((effect) => effect.unresolved_guard === true)).toBe(true);
    expect(effects.every((effect) =>
      effect.transition === undefined
      || (effect.transition.to.target.kind === "memory_entry"
        && effect.transition.to.target.source_revision !== "rev-a")
    )).toBe(true);
  });

  it("does not throw when a source_evidence seed matches a semantic relation", () => {
    const program = relation(REL);
    const start = seedProgramStates(program)[0]!;
    const from = sourceProductStateKey({
      workspace_id: "ws",
      root_kind: "source_record",
      root_id: "rec-1",
      source_version: "v1",
      content_digest: DIGEST,
      evidence_object_id: null,
      program_state: start,
      hypothesis_id: "h0",
      binding_context: "unbound",
      time_state: "as_of"
    });
    const rows = [edge("rec-1", "mem-b", REL)];
    expect(() => adjacencyEffectsForRows(rows, {
      interpretation: interpretation(program),
      asOf: AS_OF,
      liveStates: [from],
      overlay: RELATION_MILLIGRADES,
      sourceFacts: new Map([
        ["mem-b", { object_id: "mem-b", source_revision: "rev-b" }]
      ])
    })).not.toThrow();
    const effects = adjacencyEffectsForRows(rows, {
      interpretation: interpretation(program),
      asOf: AS_OF,
      liveStates: [from],
      overlay: RELATION_MILLIGRADES,
      sourceFacts: new Map([
        ["mem-b", { object_id: "mem-b", source_revision: "rev-b" }]
      ])
    });
    expect(effects.every((effect) =>
      effect.transition === undefined
      && effect.facet === undefined
      && effect.derivation === undefined
      && effect.hyperedge === undefined
    )).toBe(true);
    const andProgram = {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      kind: "hyperedge" as const,
      join: "and" as const,
      premises: [relation(REL), relation("rel_b")]
    };
    expect(() => adjacencyEffectsForRows(rows, {
      interpretation: interpretation(andProgram),
      asOf: AS_OF,
      liveStates: [{ ...from, program_state: seedProgramStates(andProgram)[0]! }],
      overlay: { ...RELATION_MILLIGRADES, rel_b: { milligrades: 800, applicable: true } },
      sourceFacts: new Map([["mem-b", { object_id: "mem-b", source_revision: "rev-b" }]])
    })).not.toThrow();
  });

  it("AND-joins A@rev-a onto B@rev-b and never inherits rev-a", () => {
    const program = {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      kind: "hyperedge" as const,
      join: "and" as const,
      premises: [relation("rel_a"), relation("rel_b")]
    };
    const start = seedProgramStates(program)[0]!;
    const from = memoryProductStateKey({
      workspace_id: "ws",
      object_id: "mem-a",
      source_revision: "rev-a",
      program_state: start,
      hypothesis_id: "h0",
      binding_context: "unbound",
      time_state: "as_of"
    });
    const overlay = {
      rel_a: { milligrades: 800, applicable: true },
      rel_b: { milligrades: 800, applicable: true }
    };
    const effects = adjacencyEffectsForRows(
      [edge("mem-a", "mem-b", "rel_a"), edge("mem-a", "mem-b", "rel_b")],
      {
        interpretation: interpretation(program),
        asOf: AS_OF,
        liveStates: [from],
        overlay,
        sourceFacts: new Map([
          ["mem-a", { object_id: "mem-a", source_revision: "rev-a" }],
          ["mem-b", { object_id: "mem-b", source_revision: "rev-b" }]
        ])
      }
    );
    const completed = effects.find((effect) => effect.hyperedge !== undefined)?.hyperedge;
    expect(completed).toBeDefined();
    expect(completed?.to.target).toEqual({
      kind: "memory_entry",
      workspace_id: "ws",
      object_id: "mem-b",
      source_revision: "rev-b"
    });
    expect(completed?.to.target.kind === "memory_entry"
      && completed.to.target.source_revision).not.toBe("rev-a");
  });

  it("does not mint an AND product when B's revision is unobserved", () => {
    const program = {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      kind: "hyperedge" as const,
      join: "and" as const,
      premises: [relation("rel_a"), relation("rel_b")]
    };
    const start = seedProgramStates(program)[0]!;
    const from = memoryProductStateKey({
      workspace_id: "ws",
      object_id: "mem-a",
      source_revision: "rev-a",
      program_state: start,
      hypothesis_id: "h0",
      binding_context: "unbound",
      time_state: "as_of"
    });
    const effects = adjacencyEffectsForRows(
      [edge("mem-a", "mem-b", "rel_a"), edge("mem-a", "mem-b", "rel_b")],
      {
        interpretation: interpretation(program),
        asOf: AS_OF,
        liveStates: [from],
        overlay: {
          rel_a: { milligrades: 800, applicable: true },
          rel_b: { milligrades: 800, applicable: true }
        }
      }
    );
    expect(effects.some((effect) => effect.hyperedge !== undefined)).toBe(false);
    expect(effects.some((effect) => effect.unresolved_guard === true)).toBe(true);
    expect(effects.every((effect) =>
      effect.hyperedge === undefined
      || (effect.hyperedge.to.target.kind === "memory_entry"
        && effect.hyperedge.to.target.source_revision !== "rev-a")
    )).toBe(true);
  });

  it("still emits routing discovery from a source_evidence seed", () => {
    const program = relation(REL);
    const start = seedProgramStates(program)[0]!;
    const from = sourceProductStateKey({
      workspace_id: "ws",
      root_kind: "source_record",
      root_id: "rec-1",
      source_version: "v1",
      content_digest: DIGEST,
      evidence_object_id: null,
      program_state: start,
      hypothesis_id: "h0",
      binding_context: "unbound",
      time_state: "as_of"
    });
    const effects = adjacencyEffectsForRows([edge("rec-1", "routed", "uses_service", "route-1")], {
      interpretation: interpretation({
        schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
        kind: "alternative",
        options: [relation(REL), relation("uses_service")]
      }),
      asOf: AS_OF,
      liveStates: [from],
      overlay: RELATION_MILLIGRADES
    });
    expect(effects.some((effect) => effect.discovery?.subject_id === "routed")).toBe(true);
    expect(effects.every((effect) => effect.transition === undefined)).toBe(true);
  });
});

function interpretation(program: QueryProgram): QueryInterpretation {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    query_id: "seam-identity",
    status: "resolved",
    snapshot_id: SNAPSHOT_ID,
    program,
    view: defaultView(),
    holes: [],
    hypotheses: []
  };
}

function relation(relationKind: string): QueryProgram {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    kind: "relation",
    relation_kind: relationKind,
    source_variable: "x",
    target_variable: "y",
    guard: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      kind: "query_predicate",
      verdict: "true",
      time_scope: "none"
    },
    facet_mode: "same_path",
    threshold_milligrades: 0
  };
}

function edge(
  sourceObjectId: string,
  targetObjectId: string,
  predicate: string,
  assertionId = predicate
) {
  return {
    assertionId,
    sourceObjectId,
    targetObjectId,
    predicate,
    validity: VALIDITY
  };
}
