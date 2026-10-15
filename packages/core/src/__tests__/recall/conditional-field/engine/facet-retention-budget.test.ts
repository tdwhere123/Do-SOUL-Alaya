import { expect, it } from "vitest";
import { ASSOCIATION_DOMAIN_ID, CONDITIONAL_FIELD_SCHEMA_VERSION, type ObserverPage, type QueryProgram } from "@do-soul/alaya-protocol";
import { applyObserverPage, createConditionalField } from "../../../../recall/conditional-field/engine/field-engine.js";
import { defaultBudget } from "../reference/deployment.fixture.js";
import { OPEN_GUARD, query } from "./relation-grounding.fixture.js";

const PROGRAM: QueryProgram = {
  schema_version: 1, kind: "relation", relation_kind: "r", source_variable: "x", target_variable: "y",
  facet_mode: "same_path", threshold_milligrades: 0, guard: OPEN_GUARD
};

it("keeps a facet whose insert was already paid when exploration is spent", () => {
  const field = createConditionalField({ interpretation: query(PROGRAM), budget: defaultBudget() });
  const page: ObserverPage = {
    schema_version: 1, query_id: field.query_id, snapshot_id: field.snapshot_id,
    cursor: { schema_version: 1, cursor_id: "adjacency", region_id: "adjacency", query_id: field.query_id,
      snapshot_id: field.snapshot_id, position: null, committed_through: null },
    observations: [], outcome: { schema_version: 1, status: "open" }, open_regions: []
  };
  const applied = applyObserverPage({ ...field, remaining_exploration: 0, remaining_work: [] }, {
    page,
    effects: [{
      observation_id: "retained-facet",
      facet: {
        schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
        path_id: "spent-exploration:route",
        obligations: [{ obligation_id: "route", domain_id: ASSOCIATION_DOMAIN_ID }],
        coordinates: [950]
      }
    }]
  });
  expect(applied.retention_rejected).toBeUndefined();
  expect(applied.facets.map((row) => row.path_id)).toEqual(["spent-exploration:route"]);
  expect(applied.remaining_work.filter((row) => row.kind === "join")).toEqual([]);
});
