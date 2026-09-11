import { afterEach, describe, expect, it } from "vitest";
import { evaluateBooleanHypergraph } from "@do-soul/alaya-graph-algorithms";
import {
  ASSOCIATION_DOMAIN_ID,
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  InformationIndexSchema,
  memoryProductStateKey,
  productStateKeyFromIndexEntry,
  sourceProductStateKey,
  type FieldSnapshot,
  type FieldValue,
  type IndexEntry,
  type MemorySearchResult,
  type RecallTargetRef,
  type RequestBudget
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "@do-soul/alaya-storage";
import {
  HISTORICAL_MEMORY_ANY_AT_K_CONTRACT,
  MIXED_KIND_FIRST_EXPOSURE_CONTRACT,
  SOURCE_GOLD_JOIN_DENOMINATOR,
  measureConditionalFieldResponse,
  type SourceGoldUnit
} from "../../../../../../apps/bench-runner/src/runs/measurement/conditional-field-measurement.js";
import { hydrateUtf8Chunk } from "../../../memory/evidence-create/source-utf8-hydrate.js";
import { sourceRowEligible } from "../../../recall/conditional-field/observers/observation-admission.js";
import type { ObserveConditionalFieldInput } from "../../../recall/conditional-field/observers/observe.js";
import { encodeRecallResult } from "../../../recall/recall-service.js";
import {
  compileConditionalFieldQuery,
  interpretationIdentity,
  UNSUPPORTED_POLICY_QUERY_ID
} from "../../../recall/conditional-field/query/compile-query.js";
import { evaluateFrozenSourcePredicate } from "../../../recall/conditional-field/query/source-predicates.js";
import {
  continueAcceptingIndex,
  projectAcceptingIndex,
  type AcceptingProjectionInput
} from "../../../recall/conditional-field/index/project-accepting-index.js";
import {
  issuedDeliveryRevoked,
  productIdOfEntry,
  rememberIssuedDelivery,
  replayIssuedDelivery,
  replayIssuedIndex
} from "../../../recall/runtime/index-continuation.js";
import {
  FAR_FUTURE_EXPIRY,
  INTERPRETATION_CLOCK,
  SNAPSHOT_ID,
  associativeView,
  defaultBudget,
  defaultView,
  identityAssociationCap
} from "../conditional-field/reference/deployment.fixture.js";
import { identitySet, plantSource, recallPlantedSource } from "./cp11-planted-source.js";

const databases = new Set<StorageDatabase>();
afterEach(() => { for (const database of databases) database.close(); databases.clear(); });

const QUERY_ID = "failed-deployment";
const DIGEST = `sha256:${"a".repeat(64)}`;
const MEASURE_NOW = "2026-09-08T00:00:00.000Z";
const MEASURE_SNAPSHOT = `sha256:${"a".repeat(64)}`;
const SOURCE_GOLD: SourceGoldUnit = {
  workspace_id: "workspace", root_kind: "source_record", root_id: "rec-1",
  source_version: "v1", content_digest: DIGEST
};

describe("CP11 delivery falsifiers", () => {
  it("E01: record-only retained source is recoverable without extraction", () => {
    const { records, reader } = plantSource((database) => databases.add(database), [
      { body: "NEEDLE original retained" }
    ]);
    const entry = recallPlantedSource(reader, "NEEDLE").entries
      .find((row) => row.target.kind === "source_evidence");
    expect(entry?.target.kind).toBe("source_evidence");
    if (entry?.target.kind !== "source_evidence") throw new Error("source_evidence required");
    expect(entry.target.root_id).toBe(records[0]!.record_id);
    expect(entry.target.evidence_object_id).toBeNull();
    expect(entry.object_id).toBeUndefined();
  });

  it("E02: same text from different origins stays two roots", () => {
    const { records, reader } = plantSource((database) => databases.add(database), [
      { body: "same spoken line", sourceId: "user" },
      { body: "same spoken line", sourceId: "assistant" }
    ]);
    const roots = recallPlantedSource(reader, "same spoken line").entries
      .filter((entry) => entry.target.kind === "source_evidence")
      .map((entry) => entry.target.kind === "source_evidence" ? entry.target.root_id : "");
    expect(records[0]!.record_id).not.toBe(records[1]!.record_id);
    expect(roots.sort()).toEqual([records[0]!.record_id, records[1]!.record_id].sort());
  });

  it("E03: omitted scope and memory created_at cannot bypass source admission", () => {
    expect(sourceRowEligible(observe("omit"), sourceRow("project"))).toBe(false);
    expect(sourceRowEligible(observe("null"), sourceRow("project"))).toBe(true);
    const guard = {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION, kind: "query_predicate" as const,
      verdict: "unresolved" as const, predicate_name: "source.event_time.interval.v1",
      interval: {
        start: "2026-09-06T00:00:00.000Z", end: "2026-09-07T00:00:00.000Z",
        time_domain: "event_time" as const
      }
    };
    expect(evaluateFrozenSourcePredicate("source.event_time.interval.v1", guard, {
      created_at: "2026-09-06T12:00:00.000Z"
    })).toBe("unresolved");
    expect(evaluateFrozenSourcePredicate("source.event_time.interval.v1", guard, {
      event_time: "2026-09-06T12:00:00.000Z"
    })).toBe("true");
  });

  it("E04: nativeByteLimit and preview size do not change the product identity set", () => {
    const { reader } = plantSource((database) => databases.add(database), [
      { body: `NEEDLE ${"x".repeat(8000)}` }
    ]);
    const compact = recallPlantedSource(reader, "NEEDLE", 16_384, 128);
    const wide = recallPlantedSource(reader, "NEEDLE", 65_536, 4_096);
    expect(identitySet(compact).length).toBeGreaterThan(0);
    expect(identitySet(compact)).toEqual(identitySet(wide));
  });

  it("E05: UTF-8 hydrate clips to a character boundary and resumes", () => {
    const first = hydrateUtf8Chunk("汉".repeat(40), { byteLimit: 8 });
    expect(first.status).toBe("chunk");
    if (first.status !== "chunk") throw new Error("chunk required");
    expect(first.complete).toBe(false);
    expect(first.end_offset % 3).toBe(0);
    expect(hydrateUtf8Chunk("汉".repeat(40), { offset: 1, byteLimit: 8 }))
      .toEqual({ status: "unavailable", reason: "utf8_boundary" });
    const second = hydrateUtf8Chunk("汉".repeat(40), { offset: first.end_offset, byteLimit: 8 });
    expect(second.status).toBe("chunk");
    if (second.status !== "chunk") throw new Error("resume chunk required");
    expect(second.start_offset).toBe(first.end_offset);
  });

  it("E06: encoded source_evidence keeps native identity without a fabricated object_id", () => {
    const { records, reader } = plantSource((database) => databases.add(database), [
      { body: "NEEDLE public transport" }
    ]);
    const candidate = encodeRecallResult(recallPlantedSource(reader, "NEEDLE"))
      .candidates.find((row) => row.object_kind === "source_evidence");
    expect(candidate?.object_id).toBeUndefined();
    expect(candidate?.target).toMatchObject({
      kind: "source_evidence", root_id: records[0]!.record_id, evidence_object_id: null
    });
    expect(candidate?.dimension).toBeUndefined();
  });

  it("O01: canonical and associative keep the same mixed-kind members", () => {
    expect(evaluateBooleanHypergraph({
      nodeIds: ["p", "q", "t"], seeds: new Map([["p", 800], ["q", 800]]),
      edges: [{ kind: "and", from: ["p", "q"], to: "t", strength: 700 }], bottom: 0, top: 1000
    }).get("t")).toBe(700);
    const members = [
      fieldValue("a", 900, { low_milligrades: 0 }),
      guaranteedFieldValue("z", 700),
      sourceValue("src-root", 600, { low_milligrades: 600 })
    ];
    const canonical = projectAcceptingIndex(baseInput({ snapshot: snapshotOf(members), view: defaultView() }));
    const associative = projectAcceptingIndex(baseInput({
      snapshot: snapshotOf(members), view: associativeView()
    }));
    expect(new Set(canonical.entries.map(memberId))).toEqual(new Set(associative.entries.map(memberId)));
    expect(canonical.entries.map(memberId)).not.toEqual(associative.entries.map(memberId));
    expect(associative.entries.map((entry) => entry.guaranteed_milligrades)).toEqual([700, 600, 0]);
    expect(associative.entries[0]?.association_milligrades).toBe(700);
    expect(associative.entries.map(memberId)[0]).toBe("z");
    expect(associative.entries.find((entry) => entry.target.kind === "source_evidence")?.object_id)
      .toBeUndefined();
  });

  it("O02: a late high-grade is delivered and a proof change is an update, not a new slot", () => {
    const a = fieldValue("a", 600);
    const b = fieldValue("b", 900);
    const first = projectAcceptingIndex(paged([a]));
    const second = continueAcceptingIndex(first, paged([a, b]));
    expect([...first.entries, ...second.entries].map(memberId)).toEqual(["a", "b"]);
    const update = continueAcceptingIndex(second, paged([fieldValue("a", 950), b]));
    expect(update.page_purpose).toBe("update");
    expect(update.product_updates).toHaveLength(1);
    expect(update.product_updates?.[0]?.update_kind).toBe("proof");
    expect(update.product_updates?.[0]?.product).toEqual(productStateKeyFromIndexEntry(first.entries[0]!));
    expect([first, second].flatMap((page) => page.entries)).toHaveLength(2);
  });

  it("O03: incompatible cap domains are unsupported instead of silently compared", () => {
    const mixed = compileCaps([
      { domain_id: ASSOCIATION_DOMAIN_ID, normalization: "identity.unit.v1",
        transfer_id: "policy.fixture.v1", transfer_version: "1" },
      { domain_id: "cosine.embedding.v1", normalization: "l2.dot.v1",
        transfer_id: "policy.fixture.v1", transfer_version: "1" }
    ]);
    expect(mixed.status).toBe("unsupported");
    expect(mixed.query_id).toBe(UNSUPPORTED_POLICY_QUERY_ID);
    expect(compileCaps([{
      domain_id: "cosine.embedding.v1", normalization: "l2.dot.v1",
      transfer_id: "policy.fixture.v1", transfer_version: "1"
    }]).status).toBe("unsupported");
    const admitted = compileCaps([identityAssociationCap()]);
    expect(admitted.status).toBe("resolved");
    expect(admitted.query_id).not.toBe(UNSUPPORTED_POLICY_QUERY_ID);
  });

  it("O04: equal-grade membership pages do not certify a stable prefix", () => {
    const index = projectAcceptingIndex(associativeInput({
      snapshot: snapshotOf([fieldValue("a", 700), fieldValue("b", 700)])
    }));
    expect(index.completeness.order_coverage).not.toBe("complete");
    expect(index.order_status).not.toBe("complete");
    expect(index.order_status).not.toBe("certified_prefix");
  });

  it("T01: zero-width exposes no membership while omitted payload does not repeat an exposed product", () => {
    const values = [guaranteedFieldValue("a", 600), guaranteedFieldValue("b", 900)];
    const zero = projectAcceptingIndex(associativeInput({
      snapshot: snapshotOf(values), budget: defaultBudget({ page_budget: 0 }), expires_at: FAR_FUTURE_EXPIRY
    }));
    expect(zero.entries).toEqual([]);
    expect(zero.product_updates).toBeUndefined();
    expect(zero.continuation).not.toBeNull();
    const rejected = projectAcceptingIndex({
      ...paged(values), remaining_reserve: 10,
      finalize_payload: (_entries, remaining) => ({ remaining, complete: false, retryable: false })
    });
    expect(rejected.entries.map(memberId)).toEqual(["b"]);
    expect(Object.keys(rejected.continuation?.emitted_revisions ?? {})).toHaveLength(1);
    expect(rejected.completeness.payload).not.toBe("complete");
  });

  it("T02: issued retry is idempotent and a revoked identity cannot replay", () => {
    const a = fieldValue("a", 600);
    const b = fieldValue("b", 900);
    const first = projectAcceptingIndex(paged([a]));
    const second = continueAcceptingIndex(first, paged([a, b]));
    const requestDigest = "cp11-t02-b-page";
    rememberIssuedDelivery({
      query_key: `${QUERY_ID}\0${SNAPSHOT_ID}`, request_digest: requestDigest, index: second
    });
    const issued = replayIssuedDelivery(requestDigest);
    expect(issued).toBeDefined();
    expect(replayIssuedIndex(issued!).entries.map(memberId)).toEqual(["b"]);
    expect(issuedDeliveryRevoked(issued!, new Set([
      productIdOfEntry(first.entries[0]!), productIdOfEntry(second.entries[0]!)
    ]))).toBe(false);
    expect(issuedDeliveryRevoked(issued!, new Set([productIdOfEntry(first.entries[0]!)]))).toBe(true);
    const revoked = projectAcceptingIndex(associativeInput({
      snapshot: snapshotOf([a]), prior_continuation: second.continuation, expires_at: FAR_FUTURE_EXPIRY
    }));
    expect(revoked.completeness.logical_index).toBe("invalidated");
    expect(revoked.entries).toEqual([]);
  });

  it("M01: record-only source gold joins independently of extracted memory ids", () => {
    expect(measureConditionalFieldResponse({
      ...goldFixture([sourceTarget()]), goldSourceUnits: [SOURCE_GOLD], goldMemoryIds: ["rec-1"]
    })).toMatchObject({
      status: "validated",
      metrics: {
        mixed_kind_first_exposure: {
          contract: MIXED_KIND_FIRST_EXPOSURE_CONTRACT, denominator: SOURCE_GOLD_JOIN_DENOMINATOR,
          gold_unit_count: 1, joined_unit_count: 1, any_at_1: { status: "hit", value: true }
        },
        historical_memory_any_at_k: {
          contract: HISTORICAL_MEMORY_ANY_AT_K_CONTRACT, hit_at_1: { status: "miss", value: false }
        }
      }
    });
    expect(measureConditionalFieldResponse({
      ...goldFixture([memoryTarget("rec-1")]), goldSourceUnits: [SOURCE_GOLD], goldMemoryIds: ["rec-1"]
    })).toMatchObject({
      status: "validated",
      metrics: {
        mixed_kind_first_exposure: { any_at_1: { status: "miss", value: false }, joined_unit_count: 0 },
        historical_memory_any_at_k: { hit_at_1: { status: "hit", value: true } }
      }
    });
    expect(measureConditionalFieldResponse(goldFixture([sourceTarget()]))).toMatchObject({
      status: "validated",
      metrics: { mixed_kind_first_exposure: { any_at_1: { status: "unavailable", value: null } } }
    });
  });

  it("M02: product_updates cannot rewrite first-exposure slots or mixed-kind Any@K", () => {
    const first = goldFixture([sourceTarget({ root_id: "other-root" })]);
    const before = measureConditionalFieldResponse({ ...first, goldSourceUnits: [SOURCE_GOLD] });
    if (before?.status !== "validated") throw new Error("validated first page expected");
    const after = measureConditionalFieldResponse({
      ...first,
      recallResult: {
        ...first.recallResult,
        index: {
          ...first.recallResult.index, page_purpose: "update" as const,
          product_updates: [{
            schema_version: 1 as const,
            product: sourceProductStateKey({
              workspace_id: "workspace", root_kind: "source_record", root_id: "rec-1",
              source_version: "v1", content_digest: DIGEST, evidence_object_id: null,
              program_state: "matched", hypothesis_id: "h-update", binding_context: "binding0",
              time_state: "current"
            }),
            update_kind: "proof" as const, revision: "rev-2"
          }]
        }
      },
      goldSourceUnits: [SOURCE_GOLD]
    });
    if (after?.status !== "validated") throw new Error("validated update page expected");
    expect(after.first_exposure_slots).toEqual(before.first_exposure_slots);
    expect(after.metrics.mixed_kind_first_exposure).toEqual(before.metrics.mixed_kind_first_exposure);
    expect(after.product_updates).toHaveLength(1);
    expect(after.evaluated_slots[0]?.target).toMatchObject({ root_id: "other-root" });
  });
});

function observe(kind: "omit" | "null"): ObserveConditionalFieldInput {
  const base = { as_of: INTERPRETATION_CLOCK, query: { interpretation_clock: INTERPRETATION_CLOCK } };
  if (kind === "omit") return base as unknown as ObserveConditionalFieldInput;
  return { ...base, authorized_scopes: null } as unknown as ObserveConditionalFieldInput;
}

function sourceRow(scope_class: string | undefined) {
  return { object_id: "mem-1", sourceRevision: "rev", lifecycle_state: "active", scope_class } as const;
}

function snapshotOf(values: readonly FieldValue[]): FieldSnapshot {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION, snapshot_id: SNAPSHOT_ID, query_id: QUERY_ID,
    seeds: [], values, retained_transitions: [], facets: []
  };
}

function fieldValue(
  objectId: string,
  milligrades: number,
  extras: Readonly<{ readonly low_milligrades?: number }> = {}
): FieldValue {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    state: memoryProductStateKey({
      workspace_id: "ws", object_id: objectId, source_revision: "rev",
      program_state: "accepting", hypothesis_id: "h0", binding_context: "default", time_state: "as_of"
    }),
    milligrades,
    accepting: true,
    ...(extras.low_milligrades === undefined ? {} : { low_milligrades: extras.low_milligrades })
  };
}

function guaranteedFieldValue(objectId: string, milligrades: number): FieldValue {
  return fieldValue(objectId, milligrades, { low_milligrades: milligrades });
}

function sourceValue(
  rootId: string,
  milligrades: number,
  extras: Readonly<{ readonly low_milligrades?: number }> = {}
): FieldValue {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    state: sourceProductStateKey({
      workspace_id: "ws", root_kind: "source_record", root_id: rootId, source_version: "rev",
      content_digest: DIGEST, evidence_object_id: null, program_state: "accepting",
      hypothesis_id: "h0", binding_context: "default", time_state: "as_of"
    }),
    milligrades,
    accepting: true,
    ...(extras.low_milligrades === undefined ? {} : { low_milligrades: extras.low_milligrades })
  };
}

function baseInput(overrides: Partial<AcceptingProjectionInput> = {}): AcceptingProjectionInput {
  return {
    snapshot: snapshotOf([]), view: defaultView(), query_id: QUERY_ID, snapshot_id: SNAPSHOT_ID,
    result_version: "v1", budget: defaultBudget(), ...overrides
  };
}

function associativeInput(overrides: Partial<AcceptingProjectionInput> = {}): AcceptingProjectionInput {
  return baseInput({
    view: associativeView(),
    observer: {
      outcome: { schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION, status: "open" },
      open_regions: [{
        schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION, region_id: "seed", kind: "seed", status: "open"
      }]
    },
    ...overrides
  });
}

function paged(values: readonly FieldValue[]): AcceptingProjectionInput {
  return associativeInput({
    snapshot: snapshotOf(values), budget: defaultBudget({ page_budget: 1 }), expires_at: FAR_FUTURE_EXPIRY
  });
}

function memberId(entry: IndexEntry): string {
  return entry.object_id ?? (entry.target.kind === "source_evidence" ? entry.target.root_id : "");
}

function compileCaps(cap_contracts: QueryViewCaps) {
  return compileConditionalFieldQuery({
    source: "typed", snapshot_id: SNAPSHOT_ID, budget: defaultBudget(),
    program: { schema_version: 1, kind: "epsilon" },
    view: { ...defaultView(), enumeration_policy: "associative", cap_contracts }
  });
}

type QueryViewCaps = NonNullable<ReturnType<typeof defaultView>["cap_contracts"]>;

function sourceTarget(
  overrides: Partial<Extract<RecallTargetRef, { kind: "source_evidence" }>> = {}
): RecallTargetRef {
  return {
    kind: "source_evidence", workspace_id: "workspace", root_kind: "source_record",
    root_id: "rec-1", source_version: "v1", content_digest: DIGEST, evidence_object_id: null, ...overrides
  };
}

function memoryTarget(object_id = "extracted-twin"): RecallTargetRef {
  return { kind: "memory_entry", workspace_id: "workspace", object_id, source_revision: "rev" };
}

function goldFixture(targets: readonly RecallTargetRef[]) {
  const budget = measureBudget();
  const compile_input = {
    source: "ordinary" as const, text: "deployment checklist",
    snapshot_id: MEASURE_SNAPSHOT, budget, interpretation_clock: MEASURE_NOW
  };
  const query_id = compileConditionalFieldQuery(compile_input).query_id;
  const interpretation_id = interpretationIdentity({ interpretation_clock: MEASURE_NOW });
  const index = InformationIndexSchema.parse({
    schema_version: 1, query_id, snapshot_id: MEASURE_SNAPSHOT, result_version: "v1",
    interpretation_id, as_of: MEASURE_NOW,
    entries: targets.map((target, offset) => ({
      schema_version: 1,
      ...(target.kind === "memory_entry" ? { object_id: target.object_id } : {}),
      target, hypothesis_id: `h${offset}`, output_binding: `binding${offset}`, role: "requested",
      association_milligrades: 850, claim: "unknown", explanation_ids: ["unresolved-explanation"],
      program_state: "matched", time_state: "current"
    })),
    completeness: {
      schema_version: 1, logical_index: "open", observed_coverage: "open",
      interpretation_coverage: "open", transport: "partial", payload: "complete", representation: "complete"
    },
    continuation: null,
    representation: {
      schema_version: 1, policy: "construct_index_then_page_then_payload",
      page_budget: 10, identity_tie_break: "serialization"
    }
  });
  const results: MemorySearchResult[] = index.entries.map((entry) => ({
    ...(entry.object_id === undefined ? {} : { object_id: entry.object_id }),
    object_kind: entry.target.kind === "source_evidence" ? "source_evidence" : "memory_entry",
    target: entry.target, relevance_score: 0.85, content_preview: "preview", evidence_pointers: [],
    selection_reason: "observed association", hypothesis_id: entry.hypothesis_id,
    output_binding: entry.output_binding, program_state: entry.program_state, time_state: entry.time_state,
    source_channels: ["conditional_field"], score_factors: { activation: 0.85, relevance: 0.85 },
    budget_state: {
      token_estimate: 1, max_entries: 10, max_total_tokens: 2000,
      remaining_entries: 0, remaining_tokens: 0, within_budget: true
    }
  }));
  const recallResult = {
    delivery_id: "delivery", protocol_version: 1, index, results, total_count: results.length,
    provider_calls: 0, garden_enqueue: 0, request_budget: budget,
    execution_receipt: {
      schema_version: 1 as const, workspace_id: "workspace", requested_budget: budget,
      compile_input, query_id, interpretation_id, snapshot_id: MEASURE_SNAPSHOT,
      interpretation_clock: MEASURE_NOW
    }
  };
  return {
    recallResult,
    deliveredResults: results.slice(0, 10).map((row, offset) => ({
      ...(row.object_id === undefined ? {} : { object_id: row.object_id }),
      target: row.target, object_kind: row.object_kind, rank: offset + 1,
      relevance_score: row.relevance_score, hypothesis_id: row.hypothesis_id,
      output_binding: row.output_binding, program_state: row.program_state, time_state: row.time_state
    })),
    queryText: "deployment checklist", workspaceId: "workspace", referenceTime: MEASURE_NOW,
    expectedIndexSnapshotId: MEASURE_SNAPSHOT, requestBudget: budget, recallLatencyMs: 12
  };
}

function measureBudget(): RequestBudget {
  return {
    schema_version: 1, work_units: 10_000, memory_bytes: 1_000_000,
    page_budget: 10, finalization_reserve: 100, min_envelope: 10
  };
}
