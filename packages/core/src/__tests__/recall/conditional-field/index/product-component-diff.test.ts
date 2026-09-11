import { describe, expect, it } from "vitest";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  memoryProductStateKey,
  productStateKeyFromIndexEntry,
  type FieldSnapshot,
  type FieldValue,
  type IndexEntry,
  type RequestBudget
} from "@do-soul/alaya-protocol";
import {
  continueAcceptingIndex,
  projectAcceptingIndex,
  type AcceptingProjectionInput
} from "../../../../recall/conditional-field/index/project-accepting-index.js";
import {
  productComponentState,
  productUpdatesBetween
} from "../../../../recall/conditional-field/index/product-component-diff.js";
import { defaultView, productIndexKey } from "../reference/deployment.fixture.js";

const SNAPSHOT_ID = `sha256:${"c".repeat(64)}`;
const DIGEST = `sha256:${"a".repeat(64)}`;
const QUERY_ID = "failed-deployment";
const EXPIRES_AT = "2099-01-01T00:00:00.000Z";

describe("product component diffs", () => {
  it("emits unknown→supported, explanation-only, proof-only, payload-only, and multi-component rows", () => {
    const base = entry("a");
    const supported = entry("a", { claim: "supported" });
    const explained = entry("a", { explanation_ids: ["exp-1"] });
    const stronger = entry("a", { association_milligrades: 950 });
    const payload = entry("src", {
      target: {
        kind: "source_evidence",
        workspace_id: "ws",
        root_kind: "source_record",
        root_id: "src",
        source_version: "rev",
        content_digest: DIGEST,
        evidence_object_id: null,
        span: {
          content_start: 0,
          content_end: 8,
          retained_extent: "excerpt",
          content_complete: false,
          original_complete: false
        }
      },
      object_id: undefined
    });
    const payloadNext = {
      ...payload,
      target: {
        ...payload.target,
        kind: "source_evidence" as const,
        span: {
          content_start: 8,
          content_end: 16,
          retained_extent: "excerpt" as const,
          content_complete: false,
          original_complete: false
        }
      }
    };
    const claimAndProof = entry("a", { claim: "supported", association_milligrades: 950 });

    expect(kinds(base, supported)).toEqual(["claim"]);
    expect(kinds(base, entry("a", { claim: "unknown" }))).toEqual([]);
    expect(kinds(supported, entry("a", { claim: "unknown" }))).toEqual(["claim"]);
    expect(kinds(supported, entry("a", { claim: "refuted" }))).toEqual(["claim"]);
    expect(kinds(base, explained)).toEqual(["payload"]);
    expect(kinds(base, stronger)).toEqual(["proof"]);
    expect(kinds(payload, payloadNext)).toEqual(["payload"]);
    expect(kinds(base, claimAndProof).sort()).toEqual(["claim", "proof"]);
  });

  it("records membership present→absent as retraction and keeps other members", () => {
    const a = fieldValue("a", 600);
    const b = fieldValue("b", 900);
    const first = projectAcceptingIndex(inputOf({
      snapshot: snapshotOf([a, b]),
      budget: budget({ page_budget: 1 }),
      expires_at: EXPIRES_AT
    }));
    expect(first.page_purpose).toBe("membership");
    const withdrawn = continueAcceptingIndex(first, inputOf({
      snapshot: snapshotOf([{ ...a, accepting: false }, b]),
      budget: budget({ page_budget: 1 }),
      expires_at: EXPIRES_AT
    }));
    expect(withdrawn.entries.map((entry) => entry.object_id)).toEqual(["b"]);
    expect(withdrawn.page_purpose).toBe("membership");
    expect(withdrawn.product_updates?.map((update) => update.update_kind)).toEqual(["retraction"]);
    expect(withdrawn.product_updates?.[0]?.product)
      .toEqual(productStateKeyFromIndexEntry(first.entries[0]!));
  });

  it("does not hide a second component change behind kind priority", () => {
    const a = fieldValue("a", 600);
    const first = projectAcceptingIndex(inputOf({
      snapshot: snapshotOf([a]),
      budget: budget({ page_budget: 1 }),
      expires_at: EXPIRES_AT
    }));
    const risen = continueAcceptingIndex(first, inputOf({
      snapshot: snapshotOf([fieldValue("a", 950)]),
      claims: new Map([[productIndexKey("a"), "supported"]]),
      budget: budget({ page_budget: 1 }),
      expires_at: EXPIRES_AT
    }));
    expect(risen.page_purpose).toBe("update");
    expect(risen.product_updates?.map((update) => update.update_kind).sort()).toEqual(["claim", "proof"]);
  });

  it("sets page_purpose from payload expansion rather than empty membership inference", () => {
    const a = fieldValue("a", 600);
    const first = projectAcceptingIndex(inputOf({
      snapshot: snapshotOf([a]),
      budget: budget({ page_budget: 1 }),
      expires_at: EXPIRES_AT
    }));
    const expanded = continueAcceptingIndex(first, inputOf({
      snapshot: snapshotOf([a]),
      budget: budget({ page_budget: 1 }),
      expires_at: EXPIRES_AT,
      payload_expansion: true
    }));
    expect(expanded.entries).toEqual([]);
    expect(expanded.page_purpose).toBe("payload");
  });
});

function kinds(previous: IndexEntry, current: IndexEntry): string[] {
  return productUpdatesBetween(
    productStateKeyFromIndexEntry(current),
    productComponentState(previous),
    productComponentState(current)
  ).map((update) => update.update_kind);
}

function entry(objectId: string, extras: Partial<IndexEntry> = {}): IndexEntry {
  const target = extras.target ?? {
    kind: "memory_entry" as const,
    workspace_id: "ws",
    object_id: objectId,
    source_revision: "rev"
  };
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    target,
    ...(target.kind === "memory_entry" ? { object_id: objectId } : {}),
    hypothesis_id: "h0",
    output_binding: "default",
    role: "associated",
    association_milligrades: 600,
    claim: "unknown",
    explanation_ids: [],
    ...extras
  };
}

function inputOf(overrides: Partial<AcceptingProjectionInput> = {}): AcceptingProjectionInput {
  return {
    snapshot: snapshotOf([]),
    view: defaultView(),
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
