import { describe, expect, it } from "vitest";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  InformationIndexSchema,
  memoryProductStateKey,
  productStateKeyFromIndexEntry,
  sharedProductIdentity,
  sourceRecallTarget,
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
  bindCommittedDelivery,
  committedProductStatesOf,
  committedRevisionsOf,
  productComponentState,
  productUpdatesBetween
} from "../../../../recall/conditional-field/index/product-component-diff.js";
import {
  retainCommittedRevisions,
  sealIssuedContinuation
} from "../../../../recall/runtime/index-continuation.js";
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
      target: sourceRecallTarget({
        workspace_id: "ws",
        root_kind: "source_record",
        root_id: "src",
        source_version: "rev",
        content_digest: DIGEST,
        evidence_object_id: null,
        span: {
          content_start: 8,
          content_end: 16,
          retained_extent: "excerpt",
          content_complete: false,
          original_complete: false
        }
      })
    };
    const claimAndProof = entry("a", { claim: "supported", association_milligrades: 950 });

    expect(kinds(base, supported)).toEqual(["claim"]);
    expect(kinds(base, entry("a", { claim: "unknown" }))).toEqual([]);
    expect(kinds(supported, entry("a", { claim: "unknown" }))).toEqual(["claim"]);
    expect(kinds(supported, entry("a", { claim: "refuted" }))).toEqual(["claim"]);
    expect(kinds(base, explained)).toEqual(["payload"]);
    expect(kinds(base, stronger)).toEqual(["proof"]);
    expect(kinds(base, entry("a"))).toEqual([]);
    expect(kinds(base, entry("a", { guaranteed_milligrades: 700 }))).toEqual(["proof"]);
    expect(kinds(
      entry("a", { guaranteed_milligrades: 700 }),
      entry("a", { guaranteed_milligrades: 800 })
    )).toEqual(["proof"]);
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

  it("keeps claim+proof updates after parse and a sealed continuation echo", () => {
    const a = fieldValue("a", 600);
    const first = projectAcceptingIndex(inputOf({
      snapshot: snapshotOf([a]),
      budget: budget({ page_budget: 1 }),
      expires_at: EXPIRES_AT
    }));
    const parsed = InformationIndexSchema.parse(first);
    expect(committedProductStatesOf(parsed)).toBeUndefined();
    const retained = retainFromProjected(first);
    const sealed = sealIssuedContinuation(parsed.continuation!);
    const echoed = JSON.parse(JSON.stringify(sealed)) as typeof sealed;
    const second = projectAcceptingIndex(inputOf({
      snapshot: snapshotOf([fieldValue("a", 950)]),
      claims: new Map([[productIndexKey("a"), "supported"]]),
      budget: budget({ page_budget: 1 }),
      expires_at: EXPIRES_AT,
      prior_continuation: echoed,
      delivered_entry_revisions: retained.delivered_entries,
      delivered_product_states: retained.delivered_products
    }));
    expect(second.product_updates?.map((update) => update.update_kind).sort()).toEqual(["claim", "proof"]);
    expect(second.product_updates).toHaveLength(2);
  });

  it("keeps the prior membership revision on retraction after parse", () => {
    const a = fieldValue("a", 600);
    const b = fieldValue("b", 900);
    const first = projectAcceptingIndex(inputOf({
      snapshot: snapshotOf([a, b]),
      budget: budget({ page_budget: 1 }),
      expires_at: EXPIRES_AT
    }));
    const membershipRevision = productComponentState(first.entries[0]!).membership_revision;
    const retained = retainFromProjected(first);
    const parsed = InformationIndexSchema.parse(first);
    const echoed = JSON.parse(JSON.stringify(sealIssuedContinuation(parsed.continuation!)));
    const withdrawn = projectAcceptingIndex(inputOf({
      snapshot: snapshotOf([{ ...a, accepting: false }, b]),
      budget: budget({ page_budget: 1 }),
      expires_at: EXPIRES_AT,
      prior_continuation: echoed,
      delivered_entry_revisions: retained.delivered_entries,
      delivered_product_states: retained.delivered_products
    }));
    expect(withdrawn.product_updates?.map((update) => update.update_kind)).toEqual(["retraction"]);
    expect(withdrawn.product_updates?.[0]?.previous_revision).toBe(membershipRevision);
    expect(withdrawn.product_updates?.[0]?.previous_revision).not.toBe("emitted");
  });

  it("does not let client emitted_revisions extras suppress a server-unknown member", () => {
    const a = fieldValue("a", 600);
    const b = fieldValue("b", 900);
    const first = projectAcceptingIndex(inputOf({
      snapshot: snapshotOf([a, b]),
      budget: budget({ page_budget: 1 }),
      expires_at: EXPIRES_AT
    }));
    const forged = {
      ...first,
      continuation: {
        ...first.continuation!,
        emitted_revisions: {
          ...first.continuation?.emitted_revisions,
          [sharedProductIdentity(b.state)]: "forged-revision"
        }
      }
    };
    bindCommittedDelivery(forged, committedRevisionsOf(first)!, committedProductStatesOf(first)!);
    const second = continueAcceptingIndex(forged, inputOf({
      snapshot: snapshotOf([a, b]),
      budget: budget({ page_budget: 1 }),
      expires_at: EXPIRES_AT
    }));
    expect(second.entries.map((entry) => entry.object_id)).toEqual(["b"]);
    expect(second.page_purpose).toBe("membership");
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

function retainFromProjected(index: ReturnType<typeof projectAcceptingIndex>): NonNullable<
  ReturnType<typeof retainCommittedRevisions>["progress"]
> {
  const revisions = committedRevisionsOf(index);
  const products = committedProductStatesOf(index);
  if (revisions === undefined || products === undefined) {
    throw new Error("projected index must bind committed product state");
  }
  bindCommittedDelivery(InformationIndexSchema.parse(index), revisions, products);
  return retainCommittedRevisions({
    revision: "projection-generation:1",
    input_references: [],
    generation: 1,
    offset: 0,
    delivered_entries: {}
  }, revisions, true, products).progress;
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
