import { describe, expect, it } from "vitest";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  memoryProductStateKey,
  type FieldValue
} from "@do-soul/alaya-protocol";
import { claimObligationAccepts } from "../../../../recall/conditional-field/index/claim-obligation.js";
import { defaultView } from "../reference/deployment.fixture.js";

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

function demand(required_claim: "any" | "supported") {
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
  it("keeps unknown associated history when required_claim is any", () => {
    expect(claimObligationAccepts(historyValue(), demand("any"), "unknown")).toBe(true);
  });

  it("filters unknown history when required_claim is supported", () => {
    expect(claimObligationAccepts(historyValue(), demand("supported"), "unknown")).toBe(false);
    expect(claimObligationAccepts(historyValue(), demand("supported"), "supported")).toBe(true);
  });
});
