import { describe, expect, it } from "vitest";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  memoryProductStateKey,
  type FieldSnapshot,
  type FieldValue,
  type InformationIndex,
  type RequestBudget
} from "@do-soul/alaya-protocol";
import {
  continueAcceptingIndex,
  projectAcceptingIndex,
  type AcceptingProjectionInput
} from "../../../../recall/conditional-field/index/project-accepting-index.js";
import {
  committedProductStatesOf,
  committedRevisionsOf
} from "../../../../recall/conditional-field/index/product-component-diff.js";
import { defaultView } from "../reference/deployment.fixture.js";

const SNAPSHOT_ID = `sha256:${"c".repeat(64)}`;
const OTHER_SNAPSHOT_ID = `sha256:${"d".repeat(64)}`;
const QUERY_ID = "accepting-projection-entry";
const RESULT_VERSION = "v1";
const EXPIRES_AT = "2099-01-01T00:00:00.000Z";

describe("accepting-index entry and continuation delivery", () => {
  it("pages then continues the same identities as one full projection", () => {
    const values = [fieldValue("a", 400), fieldValue("b", 700), fieldValue("c", 900)];
    const full = projectAcceptingIndex(inputOf({
      snapshot: snapshotOf(values),
      budget: budget({ page_budget: 8 })
    }));
    expect(deliveryView(full)).toEqual({
      ids: ["a", "b", "c"],
      milligrades: [400, 700, 900],
      completeness: {
        logical_index: "complete",
        observed_coverage: "complete",
        transport: "complete",
        payload: "complete",
        representation: "complete"
      },
      continuation: null,
      page_purpose: "membership",
      update_kinds: [],
      committed_ids: committedIdsOf(full)
    });
    expect(committedIdsOf(full)).toHaveLength(3);

    const paged = inputOf({
      snapshot: snapshotOf(values),
      budget: budget({ page_budget: 1 }),
      expires_at: EXPIRES_AT
    });
    const first = projectAcceptingIndex(paged);
    expect(deliveryView(first).ids).toEqual(["a"]);
    expect(first.continuation).not.toBeNull();
    const second = continueAcceptingIndex(first, paged);
    const third = continueAcceptingIndex(second, paged);
    expect([first, second, third].flatMap((page) => deliveryView(page).ids)).toEqual(["a", "b", "c"]);
    expect(deliveryView(third).continuation).toBeNull();
    expect(deliveryView(third).completeness.transport).toBe("complete");
  });

  it("continueAcceptingIndex re-enters with committed revisions/products from the previous page", () => {
    const values = [fieldValue("a", 400), fieldValue("b", 700)];
    const paged = inputOf({
      snapshot: snapshotOf(values),
      budget: budget({ page_budget: 1 }),
      expires_at: EXPIRES_AT
    });
    const first = projectAcceptingIndex(paged);
    const continued = continueAcceptingIndex(first, paged);
    const revisions = committedRevisionsOf(first);
    const products = committedProductStatesOf(first);
    expect(revisions).toBeDefined();
    expect(products).toBeDefined();
    const reconstructed = projectAcceptingIndex({
      ...paged,
      prior_continuation: first.continuation,
      delivered_entry_revisions: revisions,
      delivered_product_states: products,
      delivered_product_ids: new Set(Object.keys(revisions ?? {}))
    });
    expect(deliveryView(continued)).toEqual(deliveryView(reconstructed));
    expect(deliveryView(continued).ids).toEqual(["b"]);
    expect(committedIdsOf(continued)).toEqual(committedIdsOf(reconstructed));
  });

  it("exhausts remaining reserve without delivering, then continues when the reserve returns", () => {
    const values = [fieldValue("a", 400), fieldValue("b", 700)];
    const base = inputOf({
      snapshot: snapshotOf(values),
      budget: budget({ page_budget: 2 }),
      expires_at: EXPIRES_AT
    });
    const truncated = projectAcceptingIndex({ ...base, remaining_reserve: 0 });
    expect(deliveryView(truncated)).toMatchObject({
      ids: [],
      milligrades: [],
      completeness: {
        logical_index: "open",
        observed_coverage: "complete",
        transport: "partial",
        payload: "partial",
        representation: "open"
      },
      page_purpose: "membership",
      update_kinds: [],
      committed_ids: []
    });
    expect(truncated.continuation).not.toBeNull();
    const resumed = continueAcceptingIndex(truncated, { ...base, remaining_reserve: 100 });
    expect(deliveryView(resumed).ids).toEqual(["a", "b"]);
    expect(deliveryView(resumed).continuation).toBeNull();
  });

  it("keeps remaining_memory_bytes 0 from becoming a membership resource rejection", () => {
    const paged = inputOf({
      snapshot: snapshotOf([fieldValue("a", 400), fieldValue("b", 700)]),
      budget: budget({ page_budget: 1 }),
      expires_at: EXPIRES_AT,
      remaining_memory_bytes: 0
    });
    const first = projectAcceptingIndex(paged);
    expect(deliveryView(first).ids).toEqual(["a"]);
    expect(first.completeness.logical_index).not.toBe("resource_rejected");
    const second = continueAcceptingIndex(first, { ...paged, remaining_memory_bytes: 0 });
    expect(deliveryView(second).ids).toEqual(["b"]);
    expect(second.completeness.logical_index).not.toBe("resource_rejected");
  });

  it("invalidates a stale snapshot continuation instead of paging the new values", () => {
    const first = projectAcceptingIndex(inputOf({
      snapshot: snapshotOf([fieldValue("a", 400), fieldValue("b", 700)]),
      budget: budget({ page_budget: 1 }),
      expires_at: EXPIRES_AT
    }));
    expect(deliveryView(first).ids).toEqual(["a"]);
    const stale = projectAcceptingIndex(inputOf({
      snapshot: snapshotOf([fieldValue("a", 400), fieldValue("b", 700)]),
      snapshot_id: OTHER_SNAPSHOT_ID,
      budget: budget({ page_budget: 1 }),
      expires_at: EXPIRES_AT,
      prior_continuation: first.continuation
    }));
    expect(deliveryView(stale)).toEqual({
      ids: [],
      milligrades: [],
      completeness: {
        logical_index: "invalidated",
        observed_coverage: "invalidated",
        transport: "invalidated",
        payload: "invalidated",
        representation: "invalidated"
      },
      continuation: null,
      page_purpose: "membership",
      update_kinds: [],
      committed_ids: []
    });
    expect(continueAcceptingIndex(stale, inputOf({
      snapshot: snapshotOf([fieldValue("b", 700)]),
      budget: budget({ page_budget: 1 }),
      expires_at: EXPIRES_AT
    })).completeness.logical_index).toBe("invalidated");
  });

  it("retracts a committed member before exposing the next identity", () => {
    const a = fieldValue("a", 600);
    const b = fieldValue("b", 900);
    const first = projectAcceptingIndex(inputOf({
      snapshot: snapshotOf([a, b]),
      budget: budget({ page_budget: 1 }),
      expires_at: EXPIRES_AT
    }));
    expect(deliveryView(first).ids).toEqual(["a"]);
    const withdrawn = continueAcceptingIndex(first, inputOf({
      snapshot: snapshotOf([{ ...a, accepting: false }, b]),
      budget: budget({ page_budget: 1 }),
      expires_at: EXPIRES_AT
    }));
    expect(deliveryView(withdrawn)).toMatchObject({
      ids: [],
      page_purpose: "update",
      update_kinds: ["retraction"]
    });
    expect(committedProductStatesOf(withdrawn)?.[committedIdsOf(first)[0]!]?.membership_present).toBe(false);
    const later = continueAcceptingIndex(withdrawn, inputOf({
      snapshot: snapshotOf([{ ...a, accepting: false }, b]),
      budget: budget({ page_budget: 1 }),
      expires_at: EXPIRES_AT
    }));
    expect(deliveryView(later).ids).toEqual(["b"]);
    expect(deliveryView(later).update_kinds).toEqual([]);
  });
});

function deliveryView(index: InformationIndex): Readonly<{
  readonly ids: readonly string[];
  readonly milligrades: readonly number[];
  readonly completeness: Readonly<{
    readonly logical_index: string;
    readonly observed_coverage: string;
    readonly transport: string;
    readonly payload: string;
    readonly representation: string;
  }>;
  readonly continuation: string | null;
  readonly page_purpose: string;
  readonly update_kinds: readonly string[];
  readonly committed_ids: readonly string[];
}> {
  return {
    ids: index.entries.map((entry) => entry.object_id ?? ""),
    milligrades: index.entries.map((entry) => entry.association_milligrades),
    completeness: {
      logical_index: index.completeness.logical_index,
      observed_coverage: index.completeness.observed_coverage,
      transport: index.completeness.transport,
      payload: index.completeness.payload,
      representation: index.completeness.representation
    },
    continuation: index.continuation?.cursor ?? null,
    page_purpose: index.page_purpose ?? "membership",
    update_kinds: (index.product_updates ?? []).map((update) => update.update_kind),
    committed_ids: committedIdsOf(index)
  };
}

function committedIdsOf(index: InformationIndex): readonly string[] {
  return Object.keys(committedRevisionsOf(index) ?? {}).sort();
}

function inputOf(overrides: Partial<AcceptingProjectionInput> = {}): AcceptingProjectionInput {
  return {
    snapshot: snapshotOf([]),
    view: defaultView(),
    query_id: QUERY_ID,
    snapshot_id: SNAPSHOT_ID,
    result_version: RESULT_VERSION,
    budget: budget(),
    observer: {
      outcome: { schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION, status: "exhausted" },
      open_regions: []
    },
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

function budget(overrides: Partial<RequestBudget> = {}): RequestBudget {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    work_units: 10_000,
    memory_bytes: 1_000_000,
    page_budget: 30,
    finalization_reserve: 100,
    min_envelope: 10,
    ...overrides
  };
}
