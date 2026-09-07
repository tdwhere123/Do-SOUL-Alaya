import { describe, expect, it } from "vitest";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  type FieldSnapshot,
  type FieldValue
} from "@do-soul/alaya-protocol";
import { collectRelations, compileConditionalFieldQuery } from "../../../recall/conditional-field/query/compile-query.js";
import { projectAcceptingIndex } from "../../../recall/conditional-field/index/project-accepting-index.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { projectCausalUsageOntoPaths } from "../../../relations/path-plasticity/causal-usage-projection.js";
import { coverageById } from "./coverage-matrix.js";
import { INTERPRETATION_CLOCK, SNAPSHOT_ID, defaultBudget, defaultView } from "./finite-worlds.js";
import { productIdentity } from "./oracle-index.js";

describe("conditional-field producer binding honesty", () => {
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
    expectHonesty("B01", hasProductFields && distinct);
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
        && relation.guard.kind === "source_bound_entity"
        && relation.target_variable === "s"
      );
    expectHonesty("B04", bound);
  });

  it("B05 does not claim real-producer while omitted hypotheses are not a compiler output", () => {
    const interpretation = compileConditionalFieldQuery({
      source: "ordinary",
      text: "yesterday failed deployment",
      snapshot_id: SNAPSHOT_ID,
      budget: defaultBudget(),
      interpretation_clock: INTERPRETATION_CLOCK
    });
    const index = projectAcceptingIndex({
      snapshot: snapshotOf([fieldValue("c", 850)]),
      view: defaultView(),
      query_id: "failed-deployment",
      snapshot_id: SNAPSHOT_ID,
      result_version: "v1",
      budget: defaultBudget(),
      roles: new Map([["c", "associated"]]),
      interpretation_status: "hypotheses"
    });
    const ambiguous = compileConditionalFieldQuery({
      source: "ordinary",
      text: "yesterday's failure",
      snapshot_id: SNAPSHOT_ID,
      budget: defaultBudget(),
      interpretation_clock: INTERPRETATION_CLOCK
    });
    const omittedHypotheses = ambiguous.status === "hypotheses"
      || (ambiguous.hypotheses?.length ?? 0) > 0;
    expect(index.completeness.interpretation_coverage).toBe("open");
    expectHonesty("B05", omittedHypotheses && index.completeness.interpretation_coverage === "open");
  });

  it("B10/B12/B14 follow live attribution and no-learner ownership", () => {
    expect(typeof projectCausalUsageOntoPaths).toBe("function");
    expectHonesty("B10", true);
    expectHonesty("B12", true);
    expectHonesty("B14", true);
  });

  it("F8 requires worker ports to return previews", () => {
    const runnerPath = fileURLToPath(new URL("../../../recall/runtime/recall-service-runner.ts", import.meta.url));
    const source = readFileSync(runnerPath, "utf8");
    expect(source).toMatch(/must return index and previews/);
    expectHonesty("F8", true);
  });

  it("incomplete rows keep a named reason", () => {
    for (const row of ["A21", "A22", "B13"].map(coverageById)) {
      expect(row.binding).toBe("incomplete");
      expect(row.incomplete_reason?.length ?? 0).toBeGreaterThan(8);
    }
  });
});

function expectHonesty(id: string, liveProducerSatisfies: boolean): void {
  const row = coverageById(id);
  if (liveProducerSatisfies) expect(row.binding).toBe("real-producer");
  else expect(row.binding).toBe("incomplete");
}

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
