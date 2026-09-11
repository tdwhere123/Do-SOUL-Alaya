import { describe, expect, it } from "vitest";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  type QueryInterpretation,
  type RelationValidity
} from "@do-soul/alaya-protocol";
import { observeField } from "../../../../recall/runtime/conditional-field-observe.js";
import { type ObserverReaders } from "../../../../recall/conditional-field/observers/observe.js";
import { SNAPSHOT_ID, defaultBudget, defaultView } from "../reference/deployment.fixture.js";

const VALIDITY: RelationValidity = { kind: "open", valid_from: "2026-01-01T00:00:00.000Z" };
const AS_OF = "2026-09-06T00:00:00.000Z";
const EDGE_COUNT = 20;

describe("observeField adjacency paging", () => {
  it("observes many relation edges in one adjacency action instead of one-row scheduler rounds", () => {
    const seedReads: number[] = [];
    const state = observeField(interpretation(), {
      workspace_id: "workspace-1",
      query_text: "seed",
      budget: defaultBudget(),
      as_of: AS_OF,
      authorized_scopes: null,
      readers: readers(seedReads)
    });
    expect(seedReads.some((limit) => limit > 1)).toBe(true);
    expect(seedReads.length).toBeLessThan(EDGE_COUNT);
    expect(state.observed_relations).toHaveLength(EDGE_COUNT);
  });
});

function interpretation(): QueryInterpretation {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    query_id: "adjacency-page",
    status: "resolved",
    snapshot_id: SNAPSHOT_ID,
    program: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      kind: "relation",
      relation_kind: "observed_log",
      source_variable: "s",
      target_variable: "t",
      facet_mode: "same_path",
      threshold_milligrades: 0,
      guard: {
        schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
        kind: "query_predicate",
        verdict: "unresolved",
        time_scope: "none"
      }
    },
    view: defaultView(),
    holes: [],
    hypotheses: []
  };
}

function readers(seedReads: number[]): ObserverReaders {
  const edges = Array.from({ length: EDGE_COUNT }, (_, index) => ({
    assertionId: `assert-${String(index).padStart(2, "0")}`,
    sourceObjectId: "seed",
    targetObjectId: `target-${String(index).padStart(2, "0")}`,
    resultObjectId: `target-${String(index).padStart(2, "0")}`,
    predicate: "observed_log",
    validity: VALIDITY,
    evidenceRefs: ["e1"]
  }));
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
      if (input.subject === "seed") seedReads.push(input.limit);
      const matching = edges.filter((edge) =>
        (input.subject === null || edge.sourceObjectId === input.subject)
        && edge.predicate === input.predicate
      );
      const start = matching.findIndex((edge) => edge.assertionId === input.afterAssertionId) + 1;
      const observations = matching.slice(start, start + input.limit);
      return {
        observations,
        nativeVisits: observations.length,
        nativeBytes: observations.length,
        rowsRead: observations.length,
        bytesRead: observations.length,
        truncated: start + observations.length < matching.length,
        committedThrough: observations.at(-1)?.assertionId ?? input.afterAssertionId ?? null
      };
    }
  };
}
