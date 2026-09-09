import { describe, expect, it } from "vitest";
import { productStateNodeId } from "../../../../recall/conditional-field/reference/bind-max-min.js";
import { facetPathId } from "../../../../recall/conditional-field/engine/path-composition.js";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  InformationIndexSchema,
  QueryViewSchema,
  memoryProductStateKey,
  type ClaimState,
  type CoverageRegion,
  type FacetVector,
  type FieldSnapshot,
  type FieldValue,
  type IndexEntry,
  type IndexRole,
  type ObserverStatus,
  type QueryView,
  type RequestBudget,
  type SupportRecord,
  type Transition,
  type Witness
} from "@do-soul/alaya-protocol";
import {
  admitIndexBudget,
  composeCompleteness
} from "../../../../recall/conditional-field/index/completeness.js";
import {
  continueAcceptingIndex,
  evaluateFacetPredicate,
  projectAcceptingIndex,
  selectFeasibleWitnesses,
  type AcceptingProjectionInput
} from "../../../../recall/conditional-field/index/project-accepting-index.js";

const SNAPSHOT_ID = `sha256:${"c".repeat(64)}`;
const OTHER_SNAPSHOT_ID = `sha256:${"e".repeat(64)}`;
const QUERY_ID = "failed-deployment";
const RESULT_VERSION = "v1";
const EXPIRES_AT = "2099-01-01T00:00:00.000Z";

describe("conditional-field production information index", () => {
  it("keeps the five completeness dimensions independent on a paged finite index", () => {
    const index = projectAcceptingIndex(deploymentInput({
      budget: defaultBudget({ page_budget: 1 }),
      expires_at: EXPIRES_AT
    }));
    const parsed = InformationIndexSchema.parse(index);
    expect(parsed.completeness.logical_index).toBe("complete");
    expect(parsed.completeness.observed_coverage).toBe("complete");
    expect(parsed.completeness.transport).toBe("partial");
    expect(parsed.completeness.payload).toBe("partial");
    expect(parsed.completeness.representation).toBe("complete");
    expect(parsed.continuation).not.toBeNull();
    expect(JSON.stringify(parsed.completeness)).not.toContain("complete_inline");
  });

  it("does not mint complete empty for cancelled, unknown, not_applicable, unavailable, or interrupted observers", () => {
    const empty = emptySnapshot();
    for (const status of [
      "cancelled",
      "unknown",
      "not_applicable",
      "unavailable",
      "interrupted"
    ] as const) {
      const index = projectAcceptingIndex(baseInput({
        snapshot: empty,
        observer: coverage(status, status === "interrupted" ? [openRegion("seed")] : [])
      }));
      expect(index.entries).toEqual([]);
      expect(index.completeness.logical_index).not.toBe("complete");
      expect(index.completeness.observed_coverage).not.toBe("exhausted_empty");
      expect(index.completeness.observed_coverage).not.toBe("complete");
      expect(index.completeness.observed_coverage).toBe(
        status === "unavailable" ? "unavailable" : status === "interrupted" ? "interrupted" : status
      );
    }
  });

  it("closes authorized empty exhaustion and keeps unavailable coverage unavailable", () => {
    const exhausted = projectAcceptingIndex(baseInput({
      snapshot: emptySnapshot(),
      observer: coverage("exhausted")
    }));
    expect(exhausted.completeness.logical_index).toBe("complete");
    expect(exhausted.completeness.observed_coverage).toBe("exhausted_empty");
    const unavailable = projectAcceptingIndex(baseInput({
      snapshot: emptySnapshot(),
      observer: coverage("unavailable")
    }));
    expect(unavailable.completeness.logical_index).not.toBe("complete");
    expect(unavailable.completeness.observed_coverage).toBe("unavailable");
  });

  it("can complete the logical index with an unknown common-cause claim", () => {
    const index = projectAcceptingIndex(deploymentInput({
      claims: new Map<string, ClaimState>([["h", "unknown"], ["c", "unknown"]])
    }));
    expect(index.completeness.logical_index).toBe("complete");
    expect(index.entries.find((entry) => entry.object_id === "h")?.claim).toBe("unknown");
    expect(index.entries.find((entry) => entry.object_id === "c")?.association_milligrades)
      .toBe(850);
    expect(index.entries.find((entry) => entry.object_id === "c")?.program_state).toBe("accepting");
    expect(index.entries.find((entry) => entry.object_id === "c")?.time_state).toBe("as_of");
    expect(index.entries.find((entry) => entry.object_id === "s")).toBeUndefined();
  });

  it("pages keep query, snapshot and result identity and concatenate in serialization order", () => {
    const input = deploymentInput({
      budget: defaultBudget({ page_budget: 2 }),
      expires_at: EXPIRES_AT
    });
    const first = projectAcceptingIndex(input);
    const second = continueAcceptingIndex(first, input);
    expect(first.query_id).toBe(second.query_id);
    expect(first.snapshot_id).toBe(second.snapshot_id);
    expect(first.result_version).toBe(second.result_version);
    expect(first.continuation?.query_id).toBe(QUERY_ID);
    expect(first.continuation?.snapshot_id).toBe(SNAPSHOT_ID);
    expect(first.continuation?.result_version).toBe(RESULT_VERSION);
    const pages = [first, second];
    let latest = second;
    while (latest.continuation !== null) {
      latest = continueAcceptingIndex(latest, input);
      pages.push(latest);
    }
    const full = projectAcceptingIndex(deploymentInput());
    expect(pages.flatMap((page) => page.entries).map(entryKey)).toEqual(full.entries.map(entryKey));
    const keys = full.entries.map(entryKey);
    expect([...keys].sort()).toEqual(keys);
  });

  it("labels a first page as partial transport, never complete_inline", () => {
    const first = projectAcceptingIndex(deploymentInput({
      budget: defaultBudget({ page_budget: 1 }),
      expires_at: EXPIRES_AT
    }));
    expect(first.completeness.transport).toBe("partial");
    expect(first.continuation).not.toBeNull();
    expect(first.completeness.logical_index).toBe("complete");
    expect(JSON.stringify(first)).not.toContain("complete_inline");
  });

  it("orders by identity serialization rather than association strength or a fused rank", () => {
    const weakFirst = projectAcceptingIndex(baseInput({
      snapshot: snapshotOf([
        fieldValue("z", 900),
        fieldValue("a", 100)
      ]),
      roles: new Map([["z", "associated"], ["a", "associated"]])
    }));
    expect(weakFirst.entries.map((entry) => entry.object_id)).toEqual(["a", "z"]);
    expect(weakFirst.entries[0]?.association_milligrades).toBe(100);
    const swapped = projectAcceptingIndex(baseInput({
      snapshot: snapshotOf([
        fieldValue("a", 900),
        fieldValue("z", 100)
      ]),
      roles: new Map([["a", "associated"], ["z", "associated"]])
    }));
    expect(swapped.entries.map((entry) => entry.object_id)).toEqual(["a", "z"]);
    expect(new Set(swapped.entries.map((entry) => entry.object_id))).toEqual(new Set(["a", "z"]));
  });

  it("associative order uses guaranteed lower milligrades then the canonical product identity", () => {
    const members = [
      fieldValue("z", 900),
      fieldValue("a", 600)
    ];
    const canonical = projectAcceptingIndex(baseInput({
      snapshot: snapshotOf(members),
      view: defaultView({ enumeration_policy: "canonical" })
    }));
    const associative = projectAcceptingIndex(baseInput({
      snapshot: snapshotOf(members),
      view: defaultView({ enumeration_policy: "associative" })
    }));
    expect(canonical.entries.map((entry) => entry.object_id)).toEqual(["a", "z"]);
    expect(associative.entries.map((entry) => entry.object_id)).toEqual(["z", "a"]);
    expect(new Set(associative.entries.map((entry) => entry.object_id)))
      .toEqual(new Set(canonical.entries.map((entry) => entry.object_id)));
    const tied = projectAcceptingIndex(baseInput({
      snapshot: snapshotOf([fieldValue("z", 700), fieldValue("a", 700)]),
      view: defaultView({ enumeration_policy: "associative" })
    }));
    expect(tied.entries.map((entry) => entry.object_id)).toEqual(["a", "z"]);
    const mismatched = projectAcceptingIndex(baseInput({
      snapshot: snapshotOf(members),
      view: defaultView({ enumeration_policy: "associative" }),
      prior_continuation: associative.continuation === null
        ? {
          schema_version: 1,
          continuation_id: "page-1",
          query_id: QUERY_ID,
          snapshot_id: SNAPSHOT_ID,
          result_version: RESULT_VERSION,
          expires_at: EXPIRES_AT,
          cursor: "offset-0",
          enumeration_policy: "canonical",
          result_kind_view: "mixed"
        }
        : { ...associative.continuation, enumeration_policy: "canonical" }
    }));
    expect(mismatched.completeness.logical_index).toBe("invalidated");
  });

  it("does not collapse distinct hypotheses or bindings of one object", () => {
    const index = projectAcceptingIndex(baseInput({
      snapshot: snapshotOf([
        fieldValue("c", 850, { hypothesis_id: "h1" }),
        fieldValue("c", 400, { hypothesis_id: "h2" }),
        fieldValue("c", 700, { hypothesis_id: "h1", binding_context: "bind-b" })
      ]),
      roles: new Map([["c", "associated"]])
    }));
    expect(index.entries).toHaveLength(3);
    expect(index.entries.map((entry) => entry.hypothesis_id).sort()).toEqual(["h1", "h1", "h2"]);
    expect(index.entries.map((entry) => entry.output_binding).sort())
      .toEqual(["bind-b", "default", "default"]);
    expect(index.entries.every((entry) => entry.program_state === "accepting")).toBe(true);
    expect(index.entries.every((entry) => entry.time_state === "as_of")).toBe(true);
  });

  it("rejects a high activation in a nonaccepting state and hides unrequested routing-only objects", () => {
    const index = projectAcceptingIndex(baseInput({
      snapshot: snapshotOf([
        fieldValue("r", 1000),
        fieldValue("s", 900, { program_state: "routing", accepting: false }),
        fieldValue("hot", 1000, { program_state: "rejected", accepting: false })
      ]),
      roles: new Map([["r", "requested"], ["s", "routing_only"], ["hot", "associated"]])
    }));
    expect(index.entries.map((entry) => entry.object_id)).toEqual(["r"]);
  });

  it("rejects coordinate-wise max under same_path and honors a relation facet override", () => {
    const vectors: FacetVector[] = [
      { schema_version: 1, path_id: facetPathId(fieldValue("c", 1).state), coordinates: [900, 200] },
      { schema_version: 1, path_id: "c", coordinates: [200, 900] }
    ];
    expect(evaluateFacetPredicate("same_path", vectors, 800)).toBe(false);
    expect(evaluateFacetPredicate("independent", vectors, 800)).toBe(true);
    const samePath = projectAcceptingIndex(baseInput({
      snapshot: snapshotOf([fieldValue("c", 900)], { facets: vectors }),
      view: defaultView({ facet_mode: "same_path", threshold_milligrades: 800 }),
      roles: new Map([["c", "associated"]])
    }));
    expect(samePath.entries).toEqual([]);
    const independent = projectAcceptingIndex(baseInput({
      snapshot: snapshotOf([fieldValue("c", 900)], { facets: vectors }),
      view: defaultView({ facet_mode: "independent", threshold_milligrades: 800 }),
      roles: new Map([["c", "associated"]])
    }));
    expect(independent.entries).toEqual([]);
    const overridden = projectAcceptingIndex(baseInput({
      snapshot: snapshotOf([fieldValue("r", 900), fieldValue("c", 900)], {
        facets: [{ schema_version: 1, path_id: facetPathId(fieldValue("c", 1).state), coordinates: [900] }],
        retained_transitions: [transition("r", "c", "associated_config", 900)]
      }),
      view: defaultView({ facet_mode: "same_path", threshold_milligrades: 800 }),
      roles: new Map([["r", "requested"], ["c", "associated"]]),
      relation_facet_modes: new Map([["associated_config", "independent"]])
    }));
    expect(overridden.entries.some((entry) => entry.object_id === "c")).toBe(true);
  });

  it("evaluates same_path facets per candidate, not the global bag", () => {
    const weak = { schema_version: 1, path_id: facetPathId(fieldValue("a", 1).state), coordinates: [900, 200] } as const;
    const strong = { schema_version: 1, path_id: facetPathId(fieldValue("b", 1).state), coordinates: [900, 900] } as const;
    const index = projectAcceptingIndex(baseInput({
      snapshot: snapshotOf([
        fieldValue("a", 900),
        fieldValue("b", 900)
      ], { facets: [weak, strong] }),
      view: defaultView({ facet_mode: "same_path", threshold_milligrades: 800 }),
      roles: new Map([["a", "associated"], ["b", "associated"]])
    }));
    expect(index.entries.map((entry) => entry.object_id)).toEqual(["b"]);
    const dumped = projectAcceptingIndex(baseInput({
      snapshot: snapshotOf([
        fieldValue("a", 900, { hypothesis_id: "h1" }),
        fieldValue("b", 900, { hypothesis_id: "h2" })
      ]),
      support: [
        supportRecord([
          { schema_version: 1, witness_id: "for-a", premises: ["a"], cost: 1, complete: true }
        ])
      ],
      roles: new Map([["a", "associated"], ["b", "associated"]])
    }));
    expect(dumped.entries.find((entry) => entry.object_id === "a")?.explanation_ids).toEqual(["for-a"]);
    expect(dumped.entries.find((entry) => entry.object_id === "b")?.explanation_ids).toEqual([]);
  });

  it("keeps a cheaper complete witness and reports omitted payload without claiming transport failure", () => {
    const witnesses: Witness[] = [
      { schema_version: 1, witness_id: "expensive", premises: ["r"], cost: 1200, complete: true },
      { schema_version: 1, witness_id: "cheap", premises: ["r"], cost: 400, complete: true }
    ];
    expect(selectFeasibleWitnesses(witnesses, 800).map((witness) => witness.witness_id))
      .toEqual(["cheap"]);
    const withCheap = projectAcceptingIndex(deploymentInput({
      support: [supportRecord(witnesses)]
    }));
    expect(withCheap.entries.find((entry) => entry.object_id === "r")?.explanation_ids)
      .toEqual(["cheap"]);
    expect(withCheap.entries.find((entry) => entry.object_id === "c")?.explanation_ids)
      .toEqual([]);
    expect(withCheap.completeness.payload).toBe("complete");
    const omitted = projectAcceptingIndex(deploymentInput({
      budget: defaultBudget({ page_budget: 100 }),
      support: [supportRecord([
        { schema_version: 1, witness_id: "too-big", premises: ["r"], cost: 400, complete: true }
      ])]
    }));
    expect(omitted.completeness.logical_index).toBe("complete");
    expect(omitted.completeness.transport).toBe("complete");
    expect(omitted.completeness.payload).toBe("partial");
    expect(omitted.entries.every((entry) => entry.explanation_ids.length === 0)).toBe(true);
  });

  it("leaves optional payload open without blocking logical-index completion", () => {
    const index = projectAcceptingIndex(deploymentInput({
      expand_payload: false,
      claims: new Map([["h", "unknown"]])
    }));
    expect(index.completeness.logical_index).toBe("complete");
    expect(index.completeness.payload).toBe("open");
    expect(index.entries.every((entry) => entry.explanation_ids.length === 0)).toBe(true);
  });

  it("invalidates expired, revised, or identity-mismatched continuations instead of an old complete index", () => {
    const expired = projectAcceptingIndex(deploymentInput({
      budget: defaultBudget({ page_budget: 2 }),
      expires_at: "2026-01-01T00:00:00.000Z",
      as_of: "2026-09-06T00:00:00.000Z"
    }));
    expect(expired.completeness.observed_coverage).toBe("invalidated");
    expect(expired.completeness.logical_index).not.toBe("complete");
    expect(expired.continuation).toBeNull();
    const revised = projectAcceptingIndex(deploymentInput({
      prior_continuation: {
        schema_version: 1,
        continuation_id: "page-2",
        query_id: QUERY_ID,
        snapshot_id: OTHER_SNAPSHOT_ID,
        result_version: RESULT_VERSION,
        expires_at: EXPIRES_AT,
        cursor: "offset-2"
      }
    }));
    expect(revised.completeness.logical_index).not.toBe("complete");
    expect(revised.completeness.observed_coverage).toBe("invalidated");
    const first = projectAcceptingIndex(deploymentInput({
      budget: defaultBudget({ page_budget: 1 }),
      expires_at: EXPIRES_AT
    }));
    const continued = continueAcceptingIndex(first, deploymentInput({
      budget: defaultBudget({ page_budget: 1 }),
      expires_at: EXPIRES_AT
    }));
    expect(continued.completeness.logical_index).not.toBe("invalidated");
    expect(continueAcceptingIndex(continued, deploymentInput({
      as_of: "2100-01-01T00:00:00.000Z"
    })).completeness.logical_index).not.toBe("complete");
    const finished = projectAcceptingIndex(deploymentInput());
    expect(finished.continuation).toBeNull();
    expect(continueAcceptingIndex(finished, deploymentInput()).completeness.logical_index)
      .toBe("invalidated");
  });

  it("rejects an envelope that cannot fit and still pages when page_budget is smaller than min_envelope", () => {
    expect(admitIndexBudget(defaultBudget({
      work_units: 100,
      finalization_reserve: 20,
      min_envelope: 90
    }))).toBe("resource_rejected");
    const rejected = projectAcceptingIndex(deploymentInput({
      budget: defaultBudget({ work_units: 100, finalization_reserve: 20, min_envelope: 90 })
    }));
    expect(rejected.completeness.logical_index).toBe("resource_rejected");
    expect(rejected.completeness.representation).toBe("resource_rejected");
    expect(rejected.entries).toEqual([]);
    expect(rejected.continuation).toBeNull();
    const paged = projectAcceptingIndex(deploymentInput({
      budget: defaultBudget({ page_budget: 2, min_envelope: 10 }),
      expires_at: EXPIRES_AT
    }));
    expect(paged.entries.length).toBeLessThanOrEqual(2);
    expect(paged.continuation).not.toBeNull();
    expect(paged.completeness.logical_index).not.toBe("resource_rejected");
  });

  it("does not map unsupported or malformed interpretation onto a complete empty index", () => {
    for (const status of ["unsupported", "malformed", "resource_rejected"] as const) {
      const index = projectAcceptingIndex(baseInput({
        snapshot: emptySnapshot(),
        interpretation_status: status
      }));
      expect(index.entries).toEqual([]);
      expect(index.completeness.logical_index).not.toBe("complete");
      expect(index.completeness.observed_coverage).not.toBe("exhausted_empty");
    }
    const hypotheses = projectAcceptingIndex(baseInput({
      snapshot: emptySnapshot(),
      interpretation_status: "hypotheses"
    }));
    expect(hypotheses.completeness.logical_index).not.toBe("complete");
  });

  it("keeps an interrupted open frontier from completing even when current entries are stable", () => {
    const index = projectAcceptingIndex(deploymentInput({
      observer: coverage("interrupted", [
        openRegion("seed"),
        openRegion("adjacency"),
        openRegion("guard"),
        openRegion("binding")
      ])
    }));
    expect(index.entries.length).toBeGreaterThan(0);
    expect(index.completeness.logical_index).toBe("open");
    expect(index.completeness.observed_coverage).toBe("interrupted");
    expect(index.completeness.logical_index).not.toBe("complete");
  });

  it("does not invent a 9999 continuation expiry and freezes the representation policy", () => {
    const withoutExpiry = projectAcceptingIndex(deploymentInput({
      budget: defaultBudget({ page_budget: 1 })
    }));
    expect(withoutExpiry.continuation).toBeNull();
    expect(withoutExpiry.completeness.transport).toBe("partial");
    expect(JSON.stringify(withoutExpiry)).not.toContain("9999");
    const withExpiry = projectAcceptingIndex(deploymentInput({
      budget: defaultBudget({ page_budget: 1 }),
      expires_at: EXPIRES_AT
    }));
    expect(withExpiry.representation).toEqual({
      schema_version: 1,
      policy: "construct_index_then_page_then_payload",
      page_budget: 1,
      identity_tie_break: "serialization"
    });
    expect(withExpiry.continuation?.expires_at).toBe(EXPIRES_AT);
  });

  it("composes payload independently of observed coverage", () => {
    const report = composeCompleteness({
      observer: coverage("open", [openRegion("adjacency")]),
      total: 4,
      remaining: 0,
      omitted_payload: true,
      expand_payload: true
    });
    expect(report.logical_index).toBe("open");
    expect(report.observed_coverage).toBe("open");
    expect(report.transport).toBe("open");
    expect(report.payload).toBe("partial");
    expect(report.representation).toBe("open");
  });
});

function deploymentInput(
  overrides: Partial<AcceptingProjectionInput> = {}
): AcceptingProjectionInput {
  return baseInput({
    snapshot: deploymentSnapshot(),
    roles: new Map<string, IndexRole>([
      ["r", "requested"],
      ["l", "associated"],
      ["c", "associated"],
      ["s", "routing_only"],
      ["h", "associated"]
    ]),
    ...overrides
  });
}

function baseInput(overrides: Partial<AcceptingProjectionInput> = {}): AcceptingProjectionInput {
  const roles = new Map([...overrides.roles ?? []].map(([id, role]) => [productStateNodeId(fieldValue(id, 1).state), role]));
  const roots = (overrides.derivations ?? []).filter((node) => !(overrides.derivations ?? []).some((parent) => parent.children.includes(node.derivation_id)));
  return {
    snapshot: emptySnapshot(),
    view: defaultView(),
    query_id: QUERY_ID,
    snapshot_id: SNAPSHOT_ID,
    result_version: RESULT_VERSION,
    budget: defaultBudget(),
    ...overrides,
    roles,
    output_derivations: overrides.output_derivations ?? Object.fromEntries((overrides.snapshot?.values ?? []).map((value) => [productStateNodeId(value.state), roots.map((root) => root.derivation_id)]))
  };
}

function deploymentSnapshot(): FieldSnapshot {
  return snapshotOf([
    fieldValue("r", 1000),
    fieldValue("l", 950),
    fieldValue("c", 850),
    fieldValue("s", 900),
    fieldValue("h", 550)
  ], {
    seeds: [{
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      state: productKey("r"),
      milligrades: 1000
    }],
    retained_transitions: [
      transition("r", "l", "observed_log", 950),
      transition("l", "c", "config_via_log", 850),
      transition("r", "c", "config_direct", 800),
      transition("r", "s", "uses_service", 900),
      transition("s", "h", "service_history", 550)
    ]
  });
}

function emptySnapshot(): FieldSnapshot {
  return snapshotOf([]);
}

function snapshotOf(
  values: readonly FieldValue[],
  overrides: Partial<FieldSnapshot> = {}
): FieldSnapshot {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    snapshot_id: SNAPSHOT_ID,
    query_id: QUERY_ID,
    seeds: [],
    values,
    retained_transitions: [],
    facets: [],
    ...overrides
  };
}

function fieldValue(
  objectId: string,
  milligrades: number,
  extras: Partial<FieldValue["state"]> & { readonly accepting?: boolean } = {}
): FieldValue {
  const { accepting, ...state } = extras;
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    state: productKey(objectId, state),
    milligrades,
    accepting: accepting ?? (state.program_state === undefined || state.program_state === "accepting")
  };
}

function productKey(
  objectId: string,
  extras: Partial<FieldValue["state"]> = {}
): FieldValue["state"] {
  return memoryProductStateKey({
    workspace_id: "ws",
    object_id: objectId,
    source_revision: "rev",
    program_state: "accepting",
    hypothesis_id: "h0",
    binding_context: "default",
    time_state: "as_of",
    ...productStatePatch(extras)
  });
}

function productStatePatch(extras: Partial<FieldValue["state"]>): {
  readonly program_state?: string;
  readonly hypothesis_id?: string;
  readonly binding_context?: string;
  readonly time_state?: string;
} {
  return {
    ...(extras.program_state === undefined ? {} : { program_state: extras.program_state }),
    ...(extras.hypothesis_id === undefined ? {} : { hypothesis_id: extras.hypothesis_id }),
    ...(extras.binding_context === undefined ? {} : { binding_context: extras.binding_context }),
    ...(extras.time_state === undefined ? {} : { time_state: extras.time_state })
  };
}

function transition(
  from: string,
  to: string,
  relationKind: string,
  strength: number
): Transition {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    from: productKey(from),
    to: productKey(to),
    relation_kind: relationKind,
    strength_milligrades: strength,
    validity: { kind: "open", valid_from: "2026-01-01T00:00:00.000Z" },
    applicable: true
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
  return QueryViewSchema.parse({
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    requested_roles: ["requested", "associated"],
    include_routing_only: false,
    enumeration_policy: "canonical",
    result_kind_view: "mixed",
    facet_mode: "same_path",
    threshold_milligrades: 0,
    ...overrides
  });
}

function coverage(
  status: ObserverStatus,
  open_regions: readonly CoverageRegion[] = []
): AcceptingProjectionInput["observer"] {
  return {
    outcome: { schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION, status },
    open_regions
  };
}

function openRegion(kind: CoverageRegion["kind"]): CoverageRegion {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    region_id: kind,
    kind,
    status: "open"
  };
}

function supportRecord(witnesses: readonly Witness[]): SupportRecord {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    proposition_id: "cause",
    claim: "unknown",
    witnesses
  };
}

function entryKey(entry: IndexEntry): string {
  return [
    entry.hypothesis_id,
    entry.output_binding,
    entry.object_id,
    entry.program_state ?? "",
    entry.time_state ?? ""
  ].join(":");
}
