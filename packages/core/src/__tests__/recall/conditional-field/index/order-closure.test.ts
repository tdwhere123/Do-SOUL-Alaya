import { describe, expect, it } from "vitest";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  memoryProductStateKey,
  type CoverageRegion,
  type FieldSnapshot,
  type FieldValue,
  type QueryView,
  type RequestBudget
} from "@do-soul/alaya-protocol";
import { projectAcceptingIndex } from "../../../../recall/conditional-field/index/project-accepting-index.js";
import { evaluateOrderClosure } from "../../../../recall/conditional-field/index/order-closure.js";
import {
  QUERY_ID,
  SNAPSHOT_ID,
  defaultView,
  identityAssociationCap
} from "../reference/deployment.fixture.js";

const EXHAUSTED: CoverageRegion[] = [{
  schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
  region_id: "seed",
  kind: "seed",
  status: "exhausted"
}];

describe("order closure evaluator", () => {
  it("does not certify a later stronger member from an open grade remainder", () => {
    const result = evaluateOrderClosure(baseInput({
      enumeration_policy: "associative",
      remaining: 0,
      unseen_grade_coverage: "open",
      equal_grade_tie_closed: true
    }));
    expect(result.order_status).not.toBe("complete");
    expect(result.order_status).not.toBe("certified_prefix");
  });

  it("does not certify when an equal-grade earlier identity could still insert", () => {
    const result = evaluateOrderClosure(baseInput({
      enumeration_policy: "associative",
      remaining: 1,
      equal_grade_tie_closed: false
    }));
    expect(result.order_status).toBe("open");
  });

  it("stays open when memory is exhausted but a raw-source branch remains", () => {
    const result = evaluateOrderClosure(baseInput({
      remaining: 0,
      raw_source_residual: true,
      residuals: [
        ...EXHAUSTED,
        {
          schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
          region_id: "source_domain",
          kind: "source_domain",
          status: "unknown"
        }
      ]
    }));
    expect(result.order_status).not.toBe("complete");
    expect(result.order_status).toBe("open");
  });

  it("certifies a stable prefix while the tail remains open, else stays open", () => {
    const certified = evaluateOrderClosure(baseInput({ remaining: 2 }));
    expect(certified.order_status).toBe("certified_prefix");
    expect(certified.certificate).toBeDefined();
    const unproven = evaluateOrderClosure(baseInput({
      remaining: 2,
      unseen_identity_coverage: "open"
    }));
    expect(unproven.order_status).toBe("open");
  });

  it("reaches complete on a finite planted domain and not from membership pages alone", () => {
    const complete = evaluateOrderClosure(baseInput({ remaining: 0 }));
    expect(complete.order_status).toBe("complete");
    const openObserver = projectAcceptingIndex({
      snapshot: snapshotOf([fieldValue("a", 700), fieldValue("b", 700)]),
      view: view(),
      query_id: QUERY_ID,
      snapshot_id: SNAPSHOT_ID,
      result_version: "v1",
      budget: budget(),
      observer: {
        outcome: { schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION, status: "open" },
        open_regions: [{
          schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
          region_id: "seed",
          kind: "seed",
          status: "open"
        }]
      }
    });
    expect(openObserver.order_status).not.toBe("complete");
    expect(openObserver.order_status).not.toBe("certified_prefix");
    const planted = projectAcceptingIndex({
      snapshot: snapshotOf([fieldValue("a", 700), fieldValue("b", 700)]),
      view: view(),
      query_id: QUERY_ID,
      snapshot_id: SNAPSHOT_ID,
      result_version: "v1",
      budget: budget(),
      observer: {
        outcome: { schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION, status: "exhausted" },
        open_regions: EXHAUSTED
      }
    });
    expect(planted.order_status).toBe("complete");
    expect(planted.completeness.order_coverage).toBe("complete");
    expect(planted.completeness.certificate_id).toContain(":order:");
    expect(planted.completeness.certificate_id).toContain("canonical-prefix");
  });
});

function baseInput(overrides: Partial<Parameters<typeof evaluateOrderClosure>[0]> = {}) {
  return {
    query_id: QUERY_ID,
    snapshot_id: SNAPSHOT_ID,
    enumeration_policy: "canonical" as const,
    result_kind_view: "memory_only" as const,
    residuals: EXHAUSTED,
    observer: {
      outcome: { schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION, status: "exhausted" as const },
      open_regions: EXHAUSTED
    },
    remaining: 0,
    resource_open: false,
    pending_semantic_work: false,
    unseen_identity_coverage: "closed" as const,
    unseen_grade_coverage: "closed" as const,
    known_revision_coverage: "closed" as const,
    equal_grade_tie_closed: true,
    claim_eligibility_closed: true,
    raw_source_residual: false,
    ...overrides
  };
}

function snapshotOf(values: readonly FieldValue[]): FieldSnapshot {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    snapshot_id: SNAPSHOT_ID,
    query_id: QUERY_ID,
    seeds: [],
    values,
    retained_transitions: [],
    facets: []
  };
}

function fieldValue(objectId: string, milligrades: number): FieldValue {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    state: memoryProductStateKey({
      workspace_id: "ws",
      object_id: objectId,
      source_revision: "rev",
      program_state: "accepting",
      hypothesis_id: "h0",
      binding_context: "default",
      time_state: "as_of"
    }),
    milligrades,
    accepting: true
  };
}

function view(): QueryView {
  return {
    ...defaultView(),
    cap_contracts: [identityAssociationCap()]
  };
}

function budget(): RequestBudget {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    work_units: 10_000,
    memory_bytes: 1_000_000,
    page_budget: 30,
    finalization_reserve: 100,
    min_envelope: 10
  };
}
