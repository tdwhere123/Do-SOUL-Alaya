import { describe, expect, it } from "vitest";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  type FieldSnapshot,
  type FieldValue
} from "@do-soul/alaya-protocol";
import { collectRelations, compileConditionalFieldQuery } from "../../../recall/conditional-field/query/compile-query.js";
import { projectAcceptingIndex } from "../../../recall/conditional-field/index/project-accepting-index.js";
import { coverageById } from "./coverage-matrix.js";
import { INTERPRETATION_CLOCK, SNAPSHOT_ID, defaultBudget, defaultView } from "./finite-worlds.js";
import { productIdentity } from "./oracle-index.js";

describe("conditional-field compiler and projection contracts", () => {
  it("B01 does not claim real-producer while IndexEntry drops program/time", () => {
    const index = projectAcceptingIndex({
      snapshot: snapshotOf([
        fieldValue("cfg", 850, { program_state: "accepting", time_state: "yesterday" }),
        fieldValue("cfg", 400, { program_state: "accepting", time_state: "as-of" })
      ]),
      view: defaultView(),
      query_id: "failed-deployment",
      snapshot_id: SNAPSHOT_ID,
      result_version: "v1",
      budget: defaultBudget(),
      roles: new Map([["cfg", "associated"]])
    });
    const hasProductFields = index.entries.every((entry) =>
      entry.program_state !== undefined && entry.time_state !== undefined
    );
    const distinct = new Set(index.entries.map(productIdentity)).size === 2;
    expect(hasProductFields && distinct).toBe(true);
  });

  it("B04 does not claim real-producer while ordinary same-service lacks entity binding", () => {
    const interpretation = compileConditionalFieldQuery({
      source: "ordinary",
      text: "prior same-service failure around yesterday's failed deployment",
      snapshot_id: SNAPSHOT_ID,
      budget: defaultBudget(),
      interpretation_clock: INTERPRETATION_CLOCK
    });
    const bound = collectRelations(interpretation.program)
      .some((relation) =>
        relation.relation_kind === "uses_service"
        && relation.source_variable === "r"
        && relation.target_variable === "s"
      );
    expect(bound).toBe(true);
    expect(interpretation.status).toBe("partial");
  });

  it("B05 projects the actual compiler hypothesis coverage", () => {
    const ambiguous = compileConditionalFieldQuery({
      source: "ordinary", text: "yesterday's failure", snapshot_id: SNAPSHOT_ID,
      budget: defaultBudget(), interpretation_clock: INTERPRETATION_CLOCK
    });
    const index = projectAcceptingIndex({
      snapshot: snapshotOf([fieldValue("c", 850)]),
      view: defaultView(),
      query_id: "failed-deployment",
      snapshot_id: SNAPSHOT_ID,
      result_version: "v1",
      budget: defaultBudget(),
      roles: new Map([["c", "associated"]]),
      interpretation_status: ambiguous.status
    });
    const omittedHypotheses = ambiguous.status === "hypotheses"
      || (ambiguous.hypotheses?.length ?? 0) > 0;
    expect(index.completeness.interpretation_coverage).toBe("open");
    expect(omittedHypotheses).toBe(true);
  });

  it("incomplete rows keep a named reason", () => {
    for (const row of ["A21", "A22", "B13"].map(coverageById)) {
      expect(row.binding).toBe("incomplete");
      expect(row.incomplete_reason?.length ?? 0).toBeGreaterThan(8);
    }
  });
});

function snapshotOf(values: readonly FieldValue[]): FieldSnapshot {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    snapshot_id: SNAPSHOT_ID,
    query_id: "failed-deployment",
    seeds: [],
    values,
    retained_transitions: [],
    facets: []
  };
}

function fieldValue(
  objectId: string,
  milligrades: number,
  extras: Partial<FieldValue["state"]> = {}
): FieldValue {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    state: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      object_id: objectId,
      program_state: extras.program_state ?? "accepting",
      hypothesis_id: extras.hypothesis_id ?? "h0",
      binding_context: extras.binding_context ?? "default",
      time_state: extras.time_state ?? "as_of"
    },
    milligrades,
    accepting: true
  };
}
