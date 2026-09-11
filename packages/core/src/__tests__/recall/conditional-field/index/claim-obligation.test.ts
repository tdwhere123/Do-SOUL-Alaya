import { describe, expect, it } from "vitest";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  memoryProductStateKey,
  sharedProductIdentity,
  type FieldValue
} from "@do-soul/alaya-protocol";
import { claimObligationAccepts } from "../../../../recall/conditional-field/index/claim-obligation.js";
import { createConditionalField } from "../../../../recall/conditional-field/engine/field-engine.js";
import { projectAcceptingIndex } from "../../../../recall/conditional-field/index/project-accepting-index.js";
import { committedRevisionsOf, productComponentState } from "../../../../recall/conditional-field/index/product-component-diff.js";
import { productStateNodeId } from "../../../../recall/conditional-field/reference/bind-max-min.js";
import { defaultBudget, defaultView, SNAPSHOT_ID } from "../reference/deployment.fixture.js";

function historyValue(): FieldValue {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    state: memoryProductStateKey({
      workspace_id: "ws",
      object_id: "hist",
      source_revision: "rev",
      program_state: "accepting",
      hypothesis_id: "h0",
      binding_context: "h=hist",
      time_state: "as_of"
    }),
    milligrades: 1000,
    accepting: true
  };
}

function demand(required_claim: "any" | "supported" | "unknown") {
  return {
    ...defaultView(),
    claim_demands: [{
      variable: "h",
      proposition_kind: "common_cause",
      argument_variables: ["r", "h"],
      required_claim
    }]
  };
}

describe("claim obligation membership", () => {
  it("retracts a delivered unknown member when its proposition becomes supported", () => {
    const value = historyValue(), view = demand("unknown"), id = productStateNodeId(value.state);
    const field = createConditionalField({ interpretation: { schema_version: 1, query_id: "claim-refinement", snapshot_id: SNAPSHOT_ID,
      status: "resolved", program: { schema_version: 1, kind: "epsilon" }, view, hypotheses: [], holes: [] },
      budget: defaultBudget(), seeds: [{ schema_version: 1, state: value.state, milligrades: 1000 }] });
    if (field.binding.kind !== "bound") throw new Error("field rejected");
    const input = { query_id: field.query_id, snapshot_id: SNAPSHOT_ID, result_version: "1", view,
      snapshot: field.binding.snapshot, budget: defaultBudget() };
    const first = projectAcceptingIndex({ ...input, claims: new Map([[id, "unknown"]]) });
    expect(first.entries.map((entry) => entry.object_id)).toEqual(["hist"]);
    const next = projectAcceptingIndex({ ...input, result_version: "2", claims: new Map([[id, "supported"]]),
      delivered_product_ids: new Set([id]),
      delivered_entry_revisions: committedRevisionsOf(first),
      delivered_product_states: { [sharedProductIdentity(value.state)]: productComponentState(first.entries[0]!) } });
    expect(next.entries).toEqual([]);
    expect(next.product_updates).toContainEqual(expect.objectContaining({ update_kind: "retraction", product: value.state }));
  });
  it.each(["supported", "refuted", "conflict"] as const)(
    "rejects %s when the requested claim is unknown", (claim) => {
      expect(claimObligationAccepts(historyValue(), demand("unknown"), claim)).toBe(false);
      expect(claimObligationAccepts(historyValue(), demand("unknown"), "unknown")).toBe(true);
    }
  );
  it("keeps unknown associated history when required_claim is any", () => {
    expect(claimObligationAccepts(historyValue(), demand("any"), "unknown")).toBe(true);
  });

  it("filters unknown history when required_claim is supported", () => {
    expect(claimObligationAccepts(historyValue(), demand("supported"), "unknown")).toBe(false);
    expect(claimObligationAccepts(historyValue(), demand("supported"), "supported")).toBe(true);
  });
});
