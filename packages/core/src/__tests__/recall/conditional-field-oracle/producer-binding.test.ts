import { describe, expect, it } from "vitest";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  productSubjectId,
  type FieldSnapshot,
  type FieldValue
} from "@do-soul/alaya-protocol";
import {
  collectRelations,
  compileConditionalFieldQuery,
  SERVICE_VARIABLE
} from "../../../recall/conditional-field/query/compile-query.js";
import { projectAcceptingIndex } from "../../../recall/conditional-field/index/project-accepting-index.js";
import { observeField } from "../../../recall/runtime/conditional-field-observe.js";
import { type ObserverReaders } from "../../../recall/conditional-field/observers/observe.js";
import {
  INTERPRETATION_CLOCK,
  SNAPSHOT_ID,
  YESTERDAY_INSTANT,
  defaultBudget,
  defaultView
} from "./finite-worlds.js";
import { productIdentity } from "./oracle-index.js";

describe("conditional-field compiler and projection contracts", () => {
  it("does not claim real-producer while IndexEntry drops program/time", () => {
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

  it("real-producer is service-role history, not named entity_id", () => {
    const interpretation = compileConditionalFieldQuery({
      source: "ordinary",
      text: "prior same-service failure around yesterday's failed deployment",
      snapshot_id: SNAPSHOT_ID,
      budget: defaultBudget(),
      interpretation_clock: INTERPRETATION_CLOCK
    });
    const relations = collectRelations(interpretation.program);
    const usesService = relations.some((relation) =>
      relation.relation_kind === "uses_service"
      && relation.source_variable === "r"
      && relation.target_variable === SERVICE_VARIABLE
    );
    const historyOffService = relations.some((relation) =>
      relation.relation_kind === "associated_history"
      && relation.source_variable === SERVICE_VARIABLE
    );
    expect(usesService).toBe(true);
    expect(historyOffService).toBe(true);
    expect(relations.every((relation) => relation.guard.kind !== "source_bound_entity")).toBe(true);
    expect(interpretation.status).toBe("partial");
  });

  it("high-grade shared-provider bridge does not admit another service history as the same service", () => {
    const interpretation = compileConditionalFieldQuery({
      source: "ordinary",
      text: "yesterday's failed deployment",
      snapshot_id: SNAPSHOT_ID,
      budget: defaultBudget(),
      interpretation_clock: INTERPRETATION_CLOCK
    });
    const field = observeField(interpretation, {
      workspace_id: "workspace-1",
      query_text: "yesterday's failed deployment",
      budget: defaultBudget(),
      as_of: INTERPRETATION_CLOCK,
      readers: sharedProviderWorld()
    });
    const values = field.binding.kind === "bound" ? field.binding.snapshot.values : [];
    expect(field.closure.observation).toBe("exhausted");
    const historyA = values.filter((row) => productSubjectId(row.state) === "history-a");
    const historyB = values.filter((row) => productSubjectId(row.state) === "history-b");
    expect(historyA.some((row) => row.state.binding_context.includes(`${SERVICE_VARIABLE}=service-a`))).toBe(true);
    expect(historyB.some((row) => row.state.binding_context.includes(`${SERVICE_VARIABLE}=service-a`))).toBe(false);
  });

  it("projects the actual compiler hypothesis coverage", () => {
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
      target: { kind: "memory_entry" as const, workspace_id: "ws", object_id: objectId, source_revision: "rev" },
      program_state: extras.program_state ?? "accepting",
      hypothesis_id: extras.hypothesis_id ?? "h0",
      binding_context: extras.binding_context ?? "default",
      time_state: extras.time_state ?? "as_of"
    },
    milligrades,
    accepting: true
  };
}

function sharedProviderWorld(): ObserverReaders {
  const validity = { kind: "open" as const, valid_from: "2026-01-01T00:00:00.000Z" };
  const edges = [
    { assertionId: "u-a", sourceObjectId: "event-a", targetObjectId: "service-a", predicate: "uses_service" },
    { assertionId: "u-p", sourceObjectId: "event-a", targetObjectId: "shared-provider", predicate: "uses_service" },
    { assertionId: "h-a", sourceObjectId: "service-a", targetObjectId: "history-a", predicate: "service_history" },
    { assertionId: "h-p", sourceObjectId: "shared-provider", targetObjectId: "history-b", predicate: "service_history" },
    { assertionId: "h-b", sourceObjectId: "service-b", targetObjectId: "history-b", predicate: "service_history" }
  ];
  return {
    lexical: () => ({
      ids: ["event-a"],
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
        scope_class: "project",
        observed_at: YESTERDAY_INSTANT,
        created_at: "2020-01-01T00:00:00.000Z",
        content: input.objectId === "event-a" ? "failed deployment of checkout" : input.objectId
      },
      rowsRead: 1,
      bytesRead: 1,
      unavailable: false
    }),
    relation: (input) => {
      const remaining = edges
        .filter((edge) => (input.subject === null || edge.sourceObjectId === input.subject)
          && edge.predicate === input.predicate && edge.assertionId > (input.afterAssertionId ?? ""))
        .sort((left, right) => left.assertionId.localeCompare(right.assertionId));
      const observations = remaining.slice(0, Math.min(input.limit, input.nativeLimit))
        .map((edge) => ({
          ...edge,
          resultObjectId: edge.targetObjectId,
          validity,
          evidenceRefs: ["e1"]
        }));
      return {
        observations,
        nativeVisits: observations.length,
        nativeBytes: 1,
        rowsRead: observations.length,
        bytesRead: 1,
        truncated: remaining.length > observations.length,
        committedThrough: observations.at(-1)?.assertionId ?? input.afterAssertionId
      };
    }
  };
}
