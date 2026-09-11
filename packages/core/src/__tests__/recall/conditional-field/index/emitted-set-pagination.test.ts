import { describe, expect, it } from "vitest";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  InformationIndexSchema,
  QueryViewSchema,
  memoryProductStateKey,
  productStateKeyFromIndexEntry,
  type FieldSnapshot,
  type FieldValue,
  type IndexEntry,
  type QueryView,
  type RequestBudget
} from "@do-soul/alaya-protocol";
import { productStateNodeId } from "../../../../recall/conditional-field/reference/bind-max-min.js";
import {
  continueAcceptingIndex,
  projectAcceptingIndex,
  type AcceptingProjectionInput
} from "../../../../recall/conditional-field/index/project-accepting-index.js";
import { identityAssociationCap } from "../reference/deployment.fixture.js";
import {
  issuedDeliveryRevoked,
  productIdOfEntry,
  rememberIssuedDelivery,
  replayIssuedDelivery,
  replayIssuedIndex
} from "../../../../recall/runtime/index-continuation.js";

const SNAPSHOT_ID = `sha256:${"c".repeat(64)}`;
const DIGEST = `sha256:${"a".repeat(64)}`;
const QUERY_ID = "failed-deployment";
const RESULT_VERSION = "v1";
const EXPIRES_AT = "2099-01-01T00:00:00.000Z";

describe("emitted-set pagination", () => {
  it("delivers late stronger B after A instead of offsetting into [B,A]", () => {
    const a = guaranteedFieldValue("a", 600);
    const b = guaranteedFieldValue("b", 900);
    const first = projectAcceptingIndex(associativeInput({
      snapshot: snapshotOf([a]),
      budget: defaultBudget({ page_budget: 1 }),
      expires_at: EXPIRES_AT
    }));
    expect(first.entries.map(objectId)).toEqual(["a"]);
    expect(first.order_status).toBe("open");
    const second = continueAcceptingIndex(first, associativeInput({
      snapshot: snapshotOf([a, b]),
      budget: defaultBudget({ page_budget: 1 }),
      expires_at: EXPIRES_AT
    }));
    expect(second.entries.map(objectId)).toEqual(["b"]);
    const exposure = [...first.entries, ...second.entries].map(objectId);
    expect(exposure).toEqual(["a", "b"]);
    const reconstructed = projectAcceptingIndex(associativeInput({
      snapshot: snapshotOf([a, b])
    }));
    expect(reconstructed.entries.map(objectId)).toEqual(["b", "a"]);
    expect(first.entries[0]?.object_id).toBe("a");
  });

  it("canonical resume from prior_continuation.emitted_revisions delivers late A instead of skipping it", () => {
    const z = fieldValue("z", 900);
    const a = fieldValue("a", 600);
    const first = projectAcceptingIndex(canonicalOpenInput({
      snapshot: snapshotOf([z]),
      budget: defaultBudget({ page_budget: 1 }),
      expires_at: EXPIRES_AT
    }));
    expect(first.entries.map(objectId)).toEqual(["z"]);
    expect(first.continuation?.emitted_revisions).toBeDefined();
    const second = projectAcceptingIndex(canonicalOpenInput({
      snapshot: snapshotOf([a, z]),
      budget: defaultBudget({ page_budget: 1 }),
      expires_at: EXPIRES_AT,
      prior_continuation: first.continuation
    }));
    expect(second.entries.map(objectId)).toEqual(["a"]);
    expect(second.entries.map(objectId)).not.toEqual(["z"]);
  });

  it("records an A grade rise as a typed update, not a third membership slot", () => {
    const a = fieldValue("a", 600);
    const b = fieldValue("b", 900);
    const first = projectAcceptingIndex(associativeInput({
      snapshot: snapshotOf([a]),
      budget: defaultBudget({ page_budget: 1 }),
      expires_at: EXPIRES_AT
    }));
    const second = continueAcceptingIndex(first, associativeInput({
      snapshot: snapshotOf([a, b]),
      budget: defaultBudget({ page_budget: 1 }),
      expires_at: EXPIRES_AT
    }));
    const risen = fieldValue("a", 950);
    const update = continueAcceptingIndex(second, associativeInput({
      snapshot: snapshotOf([risen, b]),
      budget: defaultBudget({ page_budget: 1 }),
      expires_at: EXPIRES_AT
    }));
    expect(update.page_purpose).toBe("update");
    expect(update.product_updates).toHaveLength(1);
    expect(update.product_updates?.[0]?.update_kind).toBe("proof");
    expect(update.product_updates?.[0]?.product).toEqual(productStateKeyFromIndexEntry(first.entries[0]!));
    expect(update.entries).toEqual([]);
    const membership = [first, second]
      .filter((page) => page.page_purpose === "membership")
      .flatMap((page) => page.entries);
    expect(membership).toHaveLength(2);
    expect(new Set(membership.map(objectId))).toEqual(new Set(["a", "b"]));
  });

  it("keeps the same mixed-kind membership for canonical and associative order", () => {
    const members = [
      fieldValue("a", 900, { low_milligrades: 0 }),
      guaranteedFieldValue("z", 700),
      sourceValue("src-root", 600, { low_milligrades: 600 })
    ];
    const canonical = projectAcceptingIndex(baseInput({
      snapshot: snapshotOf(members),
      view: defaultView({ enumeration_policy: "canonical" })
    }));
    const associative = projectAcceptingIndex(baseInput({
      snapshot: snapshotOf(members),
      view: defaultView({ enumeration_policy: "associative" })
    }));
    expect(new Set(canonical.entries.map(memberKey)))
      .toEqual(new Set(associative.entries.map(memberKey)));
    expect(canonical.entries.map(objectId)).not.toEqual(associative.entries.map(objectId));
    expect(associative.entries.map((entry) => entry.guaranteed_milligrades)).toEqual([700, 600, 0]);
    expect(associative.entries.map(objectId)[0]).toBe("z");
    expect(canonical.entries.some((entry) => entry.target.kind === "source_evidence")).toBe(true);
    expect(associative.entries.find((entry) => entry.target.kind === "source_evidence")?.object_id)
      .toBeUndefined();
  });

  it("admits a source-record-only root with native identity and no memory id", () => {
    const index = InformationIndexSchema.parse(projectAcceptingIndex(baseInput({
      snapshot: snapshotOf([sourceValue("src-root", 800)])
    })));
    expect(index.entries).toHaveLength(1);
    expect(index.entries[0]?.target).toEqual({
      kind: "source_evidence",
      workspace_id: "ws",
      root_kind: "source_record",
      root_id: "src-root",
      source_version: "rev",
      content_digest: DIGEST,
      evidence_object_id: null
    });
    expect(index.entries[0]?.object_id).toBeUndefined();
  });

  it("omits unreachable products and keeps reachable zero", () => {
    const index = projectAcceptingIndex(baseInput({
      snapshot: snapshotOf([
        fieldValue("zero", 0, { activation: { kind: "reachable", milligrades: 0 } }),
        unreachableValue("ghost")
      ])
    }));
    expect(index.entries.map(objectId)).toEqual(["zero"]);
    expect(index.entries[0]?.association_milligrades).toBe(0);
  });

  it("emits nothing and consumes no undispatched product when page width is 0", () => {
    const a = guaranteedFieldValue("a", 600);
    const b = guaranteedFieldValue("b", 900);
    const zero = projectAcceptingIndex(associativeInput({
      snapshot: snapshotOf([a, b]),
      budget: defaultBudget({ page_budget: 0 }),
      expires_at: EXPIRES_AT
    }));
    expect(zero.entries).toEqual([]);
    expect(zero.product_updates).toBeUndefined();
    expect(zero.continuation).not.toBeNull();
    const next = continueAcceptingIndex(zero, associativeInput({
      snapshot: snapshotOf([a, b]),
      budget: defaultBudget({ page_budget: 1 }),
      expires_at: EXPIRES_AT
    }));
    expect(next.entries.map(objectId)).toEqual(["b"]);
  });

  it("keeps delivered membership when payload is omitted", () => {
    const input = associativeInput({
      snapshot: snapshotOf([guaranteedFieldValue("a", 600), guaranteedFieldValue("b", 900)]),
      budget: defaultBudget({ page_budget: 1 }),
      expires_at: EXPIRES_AT,
      remaining_reserve: 10
    });
    const rejected = projectAcceptingIndex({
      ...input,
      finalize_payload: (_entries, remaining) => ({ remaining, complete: false, retryable: false })
    });
    expect(rejected.entries.map(objectId)).toEqual(["b"]);
    expect(Object.keys(rejected.continuation?.emitted_revisions ?? {})).toHaveLength(1);
    const retried = continueAcceptingIndex(rejected, {
      ...input,
      finalize_payload: (_entries, remaining) => ({ remaining: remaining - 1, complete: true })
    });
    expect(retried.entries.map(objectId)).toEqual(["a"]);
  });

  it("invalidates continuation on policy, kind-view, and scope change", () => {
    const first = projectAcceptingIndex(associativeInput({
      snapshot: snapshotOf([fieldValue("a", 600)]),
      budget: defaultBudget({ page_budget: 1 }),
      expires_at: EXPIRES_AT,
      authorized_scopes: ["public"]
    }));
    expect(projectAcceptingIndex(baseInput({
      snapshot: snapshotOf([fieldValue("a", 600)]),
      view: defaultView({ enumeration_policy: "canonical" }),
      prior_continuation: first.continuation,
      expires_at: EXPIRES_AT
    })).completeness.logical_index).toBe("invalidated");
    expect(projectAcceptingIndex(associativeInput({
      snapshot: snapshotOf([fieldValue("a", 600)]),
      view: defaultView({ enumeration_policy: "associative", result_kind_view: "memory_only" }),
      prior_continuation: first.continuation,
      expires_at: EXPIRES_AT
    })).completeness.logical_index).toBe("invalidated");
    expect(projectAcceptingIndex(associativeInput({
      snapshot: snapshotOf([fieldValue("a", 600)]),
      prior_continuation: first.continuation,
      authorized_scopes: ["private"],
      expires_at: EXPIRES_AT
    })).completeness.logical_index).toBe("invalidated");
    const unrestricted = projectAcceptingIndex(associativeInput({
      snapshot: snapshotOf([fieldValue("a", 600)]),
      budget: defaultBudget({ page_budget: 1 }),
      expires_at: EXPIRES_AT,
      authorized_scopes: null
    }));
    expect(projectAcceptingIndex(associativeInput({
      snapshot: snapshotOf([fieldValue("a", 600)]),
      prior_continuation: unrestricted.continuation,
      expires_at: EXPIRES_AT
    })).completeness.logical_index).toBe("invalidated");
    expect(projectAcceptingIndex(associativeInput({
      snapshot: snapshotOf([fieldValue("a", 600)]),
      prior_continuation: unrestricted.continuation,
      authorized_scopes: [],
      expires_at: EXPIRES_AT
    })).completeness.logical_index).toBe("invalidated");
    expect(projectAcceptingIndex(associativeInput({
      snapshot: snapshotOf([fieldValue("a", 600)]),
      prior_continuation: unrestricted.continuation,
      authorized_scopes: null,
      expires_at: EXPIRES_AT
    })).completeness.logical_index).not.toBe("invalidated");
  });

  it("replays the same issued page and invalidates a revoked retry without protected bytes", () => {
    const a = fieldValue("a", 600);
    const b = fieldValue("b", 900);
    const first = projectAcceptingIndex(associativeInput({
      snapshot: snapshotOf([a]),
      budget: defaultBudget({ page_budget: 1 }),
      expires_at: EXPIRES_AT
    }));
    const second = continueAcceptingIndex(first, associativeInput({
      snapshot: snapshotOf([a, b]),
      budget: defaultBudget({ page_budget: 1 }),
      expires_at: EXPIRES_AT
    }));
    const requestDigest = "b-page";
    rememberIssuedDelivery({
      query_key: `${QUERY_ID}\0${SNAPSHOT_ID}`,
      request_digest: requestDigest,
      index: second
    });
    const issued = replayIssuedDelivery(requestDigest);
    expect(issued).toBeDefined();
    const replayed = replayIssuedIndex(issued!);
    expect(replayed.page_purpose).toBe("retry");
    expect(replayed.entries.map(objectId)).toEqual(["b"]);
    expect(issuedDeliveryRevoked(issued!, new Set([productIdOfEntry(first.entries[0]!), productIdOfEntry(second.entries[0]!)])))
      .toBe(false);
    expect(issuedDeliveryRevoked(issued!, new Set([productIdOfEntry(first.entries[0]!)]))).toBe(true);
    const revoked = projectAcceptingIndex(associativeInput({
      snapshot: snapshotOf([a]),
      prior_continuation: second.continuation,
      expires_at: EXPIRES_AT
    }));
    expect(revoked.completeness.logical_index).toBe("invalidated");
    expect(revoked.entries).toEqual([]);
    expect(JSON.stringify(revoked)).not.toContain("\"root_id\":\"b\"");
  });

  it("does not certify order complete from membership pages alone", () => {
    const index = projectAcceptingIndex(associativeInput({
      snapshot: snapshotOf([fieldValue("a", 700), fieldValue("b", 700)])
    }));
    expect(index.completeness.order_coverage).not.toBe("complete");
    expect(index.order_status).not.toBe("complete");
    expect(index.order_status).not.toBe("certified_prefix");
  });
});

function openObserver(): NonNullable<AcceptingProjectionInput["observer"]> {
  return {
    outcome: { schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION, status: "open" },
    open_regions: [{
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      region_id: "seed",
      kind: "seed",
      status: "open"
    }]
  };
}

function canonicalOpenInput(overrides: Partial<AcceptingProjectionInput> = {}): AcceptingProjectionInput {
  return baseInput({
    view: defaultView({ enumeration_policy: "canonical" }),
    observer: openObserver(),
    ...overrides
  });
}

function associativeInput(overrides: Partial<AcceptingProjectionInput> = {}): AcceptingProjectionInput {
  return baseInput({
    view: defaultView({ enumeration_policy: "associative" }),
    observer: openObserver(),
    ...overrides
  });
}

function baseInput(overrides: Partial<AcceptingProjectionInput> = {}): AcceptingProjectionInput {
  return {
    snapshot: snapshotOf([]),
    view: defaultView(),
    query_id: QUERY_ID,
    snapshot_id: SNAPSHOT_ID,
    result_version: RESULT_VERSION,
    budget: defaultBudget(),
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

function fieldValue(
  objectId: string,
  milligrades: number,
  extras: Readonly<{
    readonly accepting?: boolean;
    readonly activation?: FieldValue["activation"];
    readonly low_milligrades?: number;
  }> = {}
): FieldValue {
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
    accepting: extras.accepting ?? true,
    ...(extras.low_milligrades === undefined ? {} : { low_milligrades: extras.low_milligrades }),
    ...(extras.activation === undefined ? {} : { activation: extras.activation })
  };
}

function guaranteedFieldValue(
  objectId: string,
  milligrades: number,
  extras: Readonly<{
    readonly accepting?: boolean;
    readonly activation?: FieldValue["activation"];
  }> = {}
): FieldValue {
  return fieldValue(objectId, milligrades, { ...extras, low_milligrades: milligrades });
}

function sourceValue(
  rootId: string,
  milligrades: number,
  extras: Readonly<{ readonly low_milligrades?: number }> = {}
): FieldValue {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    state: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      target: {
        kind: "source_evidence",
        workspace_id: "ws",
        root_kind: "source_record",
        root_id: rootId,
        source_version: "rev",
        content_digest: DIGEST,
        evidence_object_id: null
      },
      program_state: "accepting",
      hypothesis_id: "h0",
      binding_context: "default",
      time_state: "as_of"
    },
    milligrades,
    accepting: true,
    ...(extras.low_milligrades === undefined ? {} : { low_milligrades: extras.low_milligrades })
  };
}

function unreachableValue(objectId: string): FieldValue {
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
    accepting: true,
    activation: { kind: "unreachable" }
  };
}

function defaultBudget(overrides: Partial<RequestBudget> = {}): RequestBudget {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    work_units: 10_000,
    memory_bytes: 1_000_000,
    page_budget: 800,
    finalization_reserve: 100,
    min_envelope: 10,
    ...overrides
  };
}

function defaultView(overrides: Partial<QueryView> = {}): QueryView {
  const parsed = QueryViewSchema.parse({
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    requested_roles: ["requested", "associated"],
    include_routing_only: false,
    enumeration_policy: "canonical",
    result_kind_view: "mixed",
    facet_mode: "same_path",
    threshold_milligrades: 0,
    ...overrides
  });
  if ((parsed.enumeration_policy ?? "canonical") !== "associative") return parsed;
  if ((parsed.cap_contracts?.length ?? 0) > 0) return parsed;
  return { ...parsed, cap_contracts: [identityAssociationCap()] };
}

function objectId(entry: IndexEntry): string {
  return entry.object_id ?? (entry.target.kind === "source_evidence" ? entry.target.root_id : "");
}

function memberKey(entry: IndexEntry): string {
  return productStateNodeId(productStateKeyFromIndexEntry(entry));
}
