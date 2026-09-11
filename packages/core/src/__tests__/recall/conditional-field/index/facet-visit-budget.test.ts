import { describe, expect, it } from "vitest";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  type FacetVector,
  type FieldSnapshot,
  type FieldValue
} from "@do-soul/alaya-protocol";
import { composedFacetPathId } from "../../../../recall/conditional-field/engine/path-composition.js";
import { projectAcceptingIndex } from "../../../../recall/conditional-field/index/project-accepting-index.js";
import type { FacetVisitIndex } from "../../../../recall/conditional-field/index/facet-visit-accounting.js";
import { startRequestCost } from "../../../../recall/runtime/request-cost-ledger.js";
import { defaultBudget, defaultView, facetObligation, productKey, SNAPSHOT_ID } from "../reference/deployment.fixture.js";

const EXPIRES_AT = "2099-01-01T00:00:00.000Z";

describe("facet collection visits against the request allowance", () => {
  it("charges inspected facet rows, not candidate count or snapshot.facets.length", () => {
    const snapshot = facetSnapshot(20);
    const cost = startRequestCost();
    let retained: FacetVisitIndex | undefined;
    let scanOffset = 0;
    const first = projectAcceptingIndex(input(snapshot, {
      remaining_reserve: 5,
      cost,
      on_projection_progress: (_offset, facet) => {
        retained = facet?.index;
        scanOffset = facet?.scan_offset ?? 0;
      }
    }));
    expect(retained?.complete).toBe(false);
    const firstVisits = cost.snapshot().phases.index.native_visits;
    const prepareRows = prepareRowsOf(snapshot);
    expect(firstVisits).toBeGreaterThan(0);
    expect(firstVisits).toBeLessThan(prepareRows);
    expect(firstVisits).not.toBe(1);
    expect(firstVisits).not.toBe(snapshot.facets.length);
    const resumed = projectAcceptingIndex(input(snapshot, {
      remaining_reserve: 40,
      cost,
      projection_facet_index: retained,
      projection_facet_offset: scanOffset,
      prior_continuation: first.continuation
    }));
    expect([...first.entries, ...resumed.entries].map((entry) => entry.object_id)).toContain("member");
    expect(cost.snapshot().native_visits).not.toBe(1);
    expect(cost.snapshot().native_visits).not.toBe(snapshot.facets.length);
  });

  it("does not admit an unindexed faceted product while the facet index is incomplete", () => {
    const pass = productKey("pass");
    const fail = productKey("fail");
    const snapshot: FieldSnapshot = {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      query_id: "query",
      snapshot_id: SNAPSHOT_ID,
      values: [fieldValue(pass, 1000), fieldValue(fail, 1000)],
      seeds: [
        { schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION, state: pass, milligrades: 1000 },
        { schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION, state: fail, milligrades: 1000 }
      ],
      retained_transitions: [],
      facets: [
        {
          schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
          path_id: composedFacetPathId(pass, "ok"),
          obligations: [{ obligation_id: "ob-pass", domain_id: "assoc.bottleneck.milligrade.v1" }],
          coordinates: [900]
        },
        {
          schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
          path_id: composedFacetPathId(fail, "bad"),
          obligations: [{ obligation_id: "ob-pass", domain_id: "assoc.bottleneck.milligrade.v1" }],
          coordinates: [100]
        }
      ]
    };
    const index = projectAcceptingIndex(input(snapshot, {
      remaining_reserve: 1,
      view: { ...defaultView(), facet_obligations: [facetObligation({ obligation_id: "ob-pass" })] }
    }));
    expect(index.entries.map((entry) => entry.object_id)).not.toContain("fail");
    expect(index.entries.map((entry) => entry.object_id)).not.toContain("pass");
  });

  it("does not treat an empty facet bag as a visit count of snapshot.seeds.length", () => {
    const state = productKey("member");
    const snapshot: FieldSnapshot = {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      query_id: "query",
      snapshot_id: SNAPSHOT_ID,
      values: [fieldValue(state, 1000)],
      seeds: [{ schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION, state, milligrades: 1000 }],
      retained_transitions: [],
      facets: []
    };
    const cost = startRequestCost();
    const index = projectAcceptingIndex(input(snapshot, { remaining_reserve: 4, cost }));
    expect(index.entries.map((entry) => entry.object_id)).toEqual(["member"]);
    expect(cost.snapshot().phases.index.native_visits).toBe(0);
  });
});

function prepareRowsOf(snapshot: FieldSnapshot): number {
  return snapshot.facets.length + snapshot.seeds.length;
}

function facetSnapshot(count: number): FieldSnapshot {
  const state = productKey("member");
  const facets: FacetVector[] = Array.from({ length: count }, (_, index) => ({
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    path_id: composedFacetPathId(state, `route-${index}`),
    coordinates: [900]
  }));
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    query_id: "query",
    snapshot_id: SNAPSHOT_ID,
    values: [fieldValue(state, 1000)],
    seeds: [{ schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION, state, milligrades: 1000 }],
    retained_transitions: [],
    facets
  };
}

function fieldValue(state: FieldValue["state"], milligrades: number): FieldValue {
  return { schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION, state, milligrades, accepting: true };
}

function input(
  snapshot: FieldSnapshot,
  extra: Partial<Parameters<typeof projectAcceptingIndex>[0]>
) {
  return {
    snapshot,
    query_id: "query",
    snapshot_id: SNAPSHOT_ID,
    result_version: "v1",
    view: defaultView(),
    budget: defaultBudget({
      work_units: extra.remaining_reserve ?? 100,
      finalization_reserve: extra.remaining_reserve ?? 100,
      min_envelope: 0,
      page_budget: 1
    }),
    grounding_complete: true as const,
    expires_at: EXPIRES_AT,
    observer: { outcome: { schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION, status: "exhausted" as const } },
    ...extra
  };
}
