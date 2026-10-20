import { afterEach, expect, it, vi } from "vitest";
import { SourceSemanticResourceExhausted, SourceSemanticResourceLedger, SourceSemanticWorkerResultSchema,
  SoulInterpretationResponseSchema, MemorySearchResultSchema, IndexEntrySchema, hashSourceRecordId, indexEntryCacheKey, sourceSemanticExecution,
  SOURCE_SEMANTIC_LIBRARY_PROTOCOL_VERSION, type SourceSemanticWorkerResult } from "@do-soul/alaya-protocol";
import { createSourceSemanticLibraryEncoding, encodeSourceSemanticLibraryResponse }
  from "../../../recall/runtime/source-semantic-library-encoding.js";
import { assembleSourceSemanticLibraryIndex, sourceSemanticLibrarySourceEntry, slotQualifiersFor,
  SOURCE_SEMANTIC_LIBRARY_ORDER } from "../../../recall/runtime/source-semantic-library-recall.js";
import { projectSourceDisclosure } from "../../../recall/runtime/source-disclosure.js";
import { fieldContractSha256 } from "../../../shared/field-hash.js";
import { preparedDeliveryId } from "../../../recall/runtime/index-continuation.js";
import { CLOCK, deliveredProofFixture } from "./source-semantic-proof-fixture.js";

type Recall = Extract<SourceSemanticWorkerResult, { kind: "recall" }>;
const digest = `sha256:${"a".repeat(64)}`;
const source = { workspace_id: "ws", source_id: "source-0", source_version: "1", content_digest: digest };
const identity = hashSourceRecordId(source, fieldContractSha256);
const budget = { work_units: 10_000_000, memory_bytes: 200_000_000 };
const meter = () => new SourceSemanticResourceLedger(budget);
afterEach(() => vi.restoreAllMocks());

function resultFor(previews: readonly string[] = ["Source bytes"], proof = false, more = false): Recall {
  const fixture = proof ? deliveredProofFixture({ library: true }) : undefined;
  const entries = previews.map((_, position) => fixture?.entry ?? sourceSemanticLibrarySourceEntry({
    workspaceId: "ws", root_id: position === 0 ? identity : `root-${position}`, source_version: "1",
    content_digest: digest, evidence_object_id: null, hypothesis_id: "library"
  }));
  const proofs = fixture === undefined ? [] : [fixture.proof];
  const { index } = assembleSourceSemanticLibraryIndex({ query_id: "query", snapshot_id: digest,
    interpretation_id: "library", as_of: CLOCK, expires_at: CLOCK, authorized_scopes: ["project"],
    source_entries: entries, selected_entries: entries,
    proof_groups: fixture === undefined ? [] : [{ entries, explanations: fixture.index.explanations }],
    truncated: false, open_residuals: false, more_roots: more });
  const result = SourceSemanticWorkerResultSchema.parse({ kind: "recall", delivery_id: preparedDeliveryId(digest, index), request_identity: digest,
    query_semantics_status: { status: "admitted", query_semantics_id: fixture?.proof.query_semantics_id ?? digest },
    protocol_version: SOURCE_SEMANTIC_LIBRARY_PROTOCOL_VERSION, total_count: entries.length, index,
    page_purpose: "membership", order: SOURCE_SEMANTIC_LIBRARY_ORDER, slot_qualifiers: slotQualifiersFor(index, proofs),
    ...(proofs.length ? { proofs } : {}),
    discovery: { eligible_source_count: entries.length, visited_source_pages: 1, visited_source_interpretation_pages: 0,
      visited_source_interpretation_descriptors: 0, candidate_prefix: [], examined_source_interpretation_ids: [],
      unexamined_source_interpretation_count: 0, omitted_duplicate_bindings: 0, examination_cap: 32,
      open_residuals: false, truncated: false },
    source_disclosures: Object.fromEntries(entries.map(entry => [indexEntryCacheKey(entry), projectSourceDisclosure({
      material_kind: "original_body", evaluated_as_of: CLOCK, proof_use: proof ? "conditional_support" : "source_only"
    })])),
    previews: Object.fromEntries(entries.map((entry, position) => [indexEntryCacheKey(entry), previews[position]])),
    coverage: { discovery: "complete", source_interpretation: "complete", query_semantics: "complete",
      semantic_correspondence: "complete", conditional_computation: "complete", payload: "complete" },
    work: { native_work: 1, native_bytes: 12, logical_memory_bytes: 12, rss_bytes: 0 }, execution: sourceSemanticExecution()
  });
  if (result.kind !== "recall") throw new Error("recall expected");
  return result;
}
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
function denyNamedCharge(ledger: SourceSemanticResourceLedger, reason: string, order?: string[]): void {
  const charge = ledger.charge.bind(ledger);
  vi.spyOn(ledger, "charge").mockImplementation((work, memory, phase) => {
    if (phase === reason) {
      order?.push("charge");
      throw new SourceSemanticResourceExhausted(phase);
    }
    return charge(work, memory, phase);
  });
}

function rawFrame(result: Recall, execution: "initial" | "continuation" = "initial") {
  const { completeness, continuation, order_status } = result.index;
  const source = result.discovery.access;
  const access = source === undefined ? undefined : { source_order: source.source_candidates.map(row => result.index.entries.findIndex(entry =>
    entry.target.kind === "source_evidence" && entry.target.root_id === row.record_id)), trace: source.trace };
  return { index: { completeness, continuation, order_status }, access, slot_qualifiers: result.slot_qualifiers,
    payload: result.coverage.payload, execution };
}
function singleton(result: Recall): Recall {
  const entry = result.index.entries[0]!, key = indexEntryCacheKey(entry), index = { ...result.index, entries: [entry] };
  return { ...result, total_count: 1, index, delivery_id: preparedDeliveryId(result.request_identity, index),
    previews: { [key]: result.previews![key]! }, source_disclosures: { [key]: result.source_disclosures[key]! },
    slot_qualifiers: slotQualifiersFor(index, []) };
}
function pageOf(result: Recall, positions: readonly number[]): Recall {
  const entries = positions.map(position => result.index.entries[position]!);
  const index = { ...result.index, entries };
  return { ...result, total_count: entries.length, index, delivery_id: preparedDeliveryId(result.request_identity, index),
    previews: Object.fromEntries(entries.map(entry => [indexEntryCacheKey(entry), result.previews![indexEntryCacheKey(entry)]!])),
    source_disclosures: Object.fromEntries(entries.map(entry => [indexEntryCacheKey(entry), result.source_disclosures[indexEntryCacheKey(entry)]!])),
    slot_qualifiers: slotQualifiersFor(index, []) };
}

it.each([false, true])("reuses admitted raw components for exact incremental frames (continuing=%s)", more => {
  const result = resultFor(["a\"\\\n🙂界", "second"], false, more), ledger = meter();
  const initial = singleton(result), session = createSourceSemanticLibraryEncoding(ledger);
  const parse = vi.spyOn(SoulInterpretationResponseSchema, "parse"), project = vi.spyOn(MemorySearchResultSchema, "parse");
  try {
    const raw = session.prepareRaw(initial)!;
    expect(raw).not.toBeNull();
    const entry = result.index.entries[1]!, key = indexEntryCacheKey(entry);
    const second = raw.member({ entry, preview: result.previews![key]!, source_disclosure: result.source_disclosures[key]! })!;
    expect(project).toHaveBeenCalledTimes(1); expect(parse).toHaveBeenCalledTimes(1);
    for (const payload of ["complete", "truncated"] as const) {
      const input = { ...result, coverage: { ...result.coverage, payload },
        delivery_id: preparedDeliveryId(result.request_identity, result.index) };
      const parses = parse.mock.calls.length;
      const quote = raw.quote(rawFrame(input), [...raw.members, second]);
      expect(parse).toHaveBeenCalledTimes(parses); expect(project).toHaveBeenCalledTimes(1);
      const encoded = encodeSourceSemanticLibraryResponse(input);
      expect(quote.bytes).toBe(bytes(encoded));
      expect(quote.withinBudget).toBe(true);
      const finalMeter = meter(), final = createSourceSemanticLibraryEncoding(finalMeter);
      try { expect(quote.capture).toEqual(final.materialize(input).capture); } finally { final.close(); }
    }
  } finally { session.close(); }
});

it("keeps immutable raw member evidence independent of mutated callers and rejects accessor/foreign handles", () => {
  const result = resultFor(["first", "second"]), initial = singleton(result), session = createSourceSemanticLibraryEncoding(meter());
  const raw = session.prepareRaw(initial)!, entry = result.index.entries[1]!, key = indexEntryCacheKey(entry);
  const input = structuredClone({ entry, preview: "second", source_disclosure: result.source_disclosures[key]! });
  const member = raw.member(input)!;
  const frame = rawFrame({ ...result, delivery_id: preparedDeliveryId(result.request_identity, result.index) });
  const before = raw.quote(frame, [...raw.members, member]);
  input.preview = "changed"; Object.assign(input.entry, { output_binding: "changed" });
  expect(raw.quote(frame, [...raw.members, member])).toEqual(before);
  const accessor = vi.fn(() => "unsafe");
  Object.defineProperty(input, "preview", { get: accessor });
  expect(() => raw.member(input)).toThrow(/data properties/u); expect(accessor).not.toHaveBeenCalled();
  expect(() => raw.quote(frame, [{ kind: "raw_library_member" }])).toThrow(/another encoding session/u);
  session.close();
  expect(() => raw.quote(frame, raw.members)).toThrow(/session is closed/u);
});

it("does not confuse reusable raw bytes with atomic token admission or proof eligibility", () => {
  const result = resultFor(["x".repeat(8_004)]), session = createSourceSemanticLibraryEncoding(meter());
  try {
    const raw = session.prepareRaw(result)!;
    expect(raw.initial.withinBudget).toBe(false);
    const input = { ...result, delivery_id: preparedDeliveryId(result.request_identity, result.index) };
    const quote = raw.quote(rawFrame(input), raw.members);
    expect(quote.withinBudget).toBe(false); expect(quote.bytes).toBe(bytes(encodeSourceSemanticLibraryResponse(input)));
    expect(session.prepareRaw(resultFor(["Alice uses X."], true))).toBeNull();
    for (const units of [4_000, 4_004]) {
      const pair = resultFor(["x".repeat(4_000), "y".repeat(units)]), prepared = session.prepareRaw(singleton(pair))!;
      const entry = pair.index.entries[1]!, key = indexEntryCacheKey(entry);
      const second = prepared.member({ entry, preview: pair.previews![key]!, source_disclosure: pair.source_disclosures[key]! })!;
      const input = { ...pair, delivery_id: preparedDeliveryId(pair.request_identity, pair.index) };
      const quote = prepared.quote(rawFrame(input), [...prepared.members, second]);
      expect(quote.withinBudget).toBe(units === 4_000);
      expect(quote.bytes).toBe(bytes(encodeSourceSemanticLibraryResponse(input)));
    }
  } finally { session.close(); }
});

it("recomputes later combination admission from captured members instead of the initial page rejection", () => {
  const pair = resultFor(["x".repeat(4_000), "y".repeat(4_004)]), session = createSourceSemanticLibraryEncoding(meter());
  try {
    const raw = session.prepareRaw(pair)!;
    expect(raw).not.toBeNull();
    expect(raw.initial.withinBudget).toBe(false);
    const encodedPair = encodeSourceSemanticLibraryResponse(pair);
    expect("results" in encodedPair && encodedPair.results!.every(row => row.budget_state.within_budget)).toBe(false);
    for (const position of [0, 1] as const) {
      const encoded = encodeSourceSemanticLibraryResponse(pageOf(pair, [position]));
      expect("results" in encoded && encoded.results!.every(row => row.budget_state.within_budget)).toBe(true);
    }
    for (const positions of [[0, 1], [0], [1]] as const) {
      const input = pageOf(pair, positions);
      const encoded = encodeSourceSemanticLibraryResponse(input);
      const quote = raw.quote(rawFrame(input), positions.map(position => raw.members[position]!));
      expect(quote.bytes).toBe(bytes(encoded));
      expect(quote.withinBudget).toBe("results" in encoded && encoded.results!.every(row => row.budget_state.within_budget));
    }
  } finally { session.close(); }
});

it("rejects runtime-missing incremental previews while admitting present empty source", () => {
  const pair = resultFor(["first", "second"]), ledger = meter();
  const session = createSourceSemanticLibraryEncoding(ledger);
  try {
    const raw = session.prepareRaw(singleton(pair))!;
    const entry = pair.index.entries[1]!, key = indexEntryCacheKey(entry);
    const disclosure = pair.source_disclosures[key]!;
    const template = structuredClone({ entry, preview: pair.previews![key]!, source_disclosure: disclosure });
    const missing = structuredClone(template);
    Reflect.deleteProperty(missing, "preview");
    const unset = Object.assign(structuredClone(template), { preview: undefined });
    const spent = ledger.spentWork;
    expect(raw.member(missing)).toBeNull();
    expect(raw.member(unset)).toBeNull();
    expect(ledger.spentWork).toBeGreaterThan(spent);
    const empty = raw.member({ entry, preview: "", source_disclosure: disclosure });
    expect(empty).not.toBeNull();
    const input = pageOf({ ...pair, previews: { ...pair.previews, [key]: "" } }, [1]);
    const encoded = encodeSourceSemanticLibraryResponse(input);
    expect("results" in encoded && encoded.results?.[0]?.content_preview).toBe("[empty source]");
    const quote = raw.quote(rawFrame(input), [empty!]);
    expect(quote.bytes).toBe(bytes(encoded));
    expect(quote.withinBudget).toBe(true);
  } finally { session.close(); }
});

it.each([false, true])("quotes escaped UTF-8 and both payload states exactly (continuing=%s)", more => {
  const session = createSourceSemanticLibraryEncoding(meter());
  try {
    for (const text of ["a\"\\\n\u0000🙂界\ud800", "", "x".repeat(8_004)]) {
      const result = resultFor([text], false, more);
      const raw = session.prepareRaw(result)!;
      for (const payload of ["complete", "truncated"] as const) {
        const input = { ...result, coverage: { ...result.coverage, payload } };
        const encoded = encodeSourceSemanticLibraryResponse(input), quote = raw.quote(rawFrame(input), raw.members);
        expect(Object.isFrozen(quote)).toBe(true);
        expect(quote.bytes).toBe(bytes(encoded));
        expect(quote.withinBudget).toBe("results" in encoded && encoded.results!.every(row => row.budget_state.within_budget));
        const boundary = bytes(encoded);
        expect(quote.bytes <= boundary).toBe(true);
        expect(quote.bytes <= boundary - 1).toBe(false);
        expect(bytes(session.materialize(input).response)).toBe(boundary);
      }
    }
  } finally { session.close(); }
});

it("does not admit atomic proof support over 2,000 tokens even in a roomy byte envelope", () => {
  const result = resultFor(["x".repeat(8_004)], true), session = createSourceSemanticLibraryEncoding(meter());
  try {
    expect(session.prepareRaw(result)).toBeNull();
    const encoded = session.materialize(result).response;
    expect(bytes(encoded)).toBeLessThan(1_000_000);
    expect(bytes(encoded)).toBe(bytes(encodeSourceSemanticLibraryResponse(result)));
    expect("results" in encoded && encoded.results !== undefined && encoded.results.every(row => row.budget_state.within_budget)).toBe(false);
    const available = resultFor(["Alice uses X."], true);
    const admitted = session.materialize(available).response;
    expect("results" in admitted && admitted.results !== undefined && admitted.results.every(row => row.budget_state.within_budget)).toBe(true);
    const qualifier = available.slot_qualifiers[0]!;
    expect(() => session.materialize({ ...available, slot_qualifiers: [{ ...qualifier, conditional_computation_id: digest }] }))
      .toThrow(/proof/u);
  } finally { session.close(); }
});

it("revalidates unproved identities rather than treating a prior valid quote as admission", () => {
  const result = resultFor(), session = createSourceSemanticLibraryEncoding(meter());
  const computation = { kind: "complete_zero_binding" as const, conclusion_scope: "conditional_on_interpretation" as const,
    world_claim: "unknown" as const, source_record: { ...source, identity }, source_interpretation_id: digest,
    query_semantics_id: digest, semantic_correspondence_id: digest, conditional_computation_id: digest,
    completeness: result.index.completeness };
  const input = { ...result, unproved_computations: [computation] };
  try {
    expect(bytes(session.materialize(input).response)).toBe(bytes(encodeSourceSemanticLibraryResponse(input)));
    expect(() => session.materialize({ ...input, unproved_computations: [{ ...computation,
      source_record: { ...computation.source_record, source_id: "substituted" } }] })).toThrow(/unproved source record/u);
    expect(() => session.materialize({ ...input, execution: undefined })).toThrow(/actual execution accounting/u);
  } finally { session.close(); }
});

it("captures before schema validation without freezing or rereading the caller", () => {
  const input = structuredClone(resultFor()), session = createSourceSemanticLibraryEncoding(meter());
  const expected = bytes(encodeSourceSemanticLibraryResponse(input)), key = Object.keys(input.previews!)[0]!;
  const parse = SoulInterpretationResponseSchema.parse.bind(SoulInterpretationResponseSchema);
  vi.spyOn(SoulInterpretationResponseSchema, "parse").mockImplementation(value => {
    Object.assign(input.previews!, { [key]: "changed during validation" });
    return parse(value);
  });
  try {
    expect(bytes(session.materialize(input).response)).toBe(expected);
    expect(Object.isFrozen(input.previews)).toBe(false);
    expect(input.previews![key]).toBe("changed during validation");
    expect(bytes(session.materialize(input).response)).not.toBe(expected);
  } finally { session.close(); }
});

it("binds changed combinations, scope, revision and disclosure metadata independently of any member ordinal", () => {
  const result = resultFor(), session = createSourceSemanticLibraryEncoding(meter());
  try {
    const before = bytes(session.materialize(result).response);
    const key = Object.keys(result.source_disclosures)[0]!;
    const variants = [resultFor(["a different pair", "second"]),
      { ...result, index: { ...result.index, snapshot_id: `sha256:${"b".repeat(64)}` } },
      { ...result, index: { ...result.index, continuation: { ...resultFor(["Source bytes"], false, true).index.continuation!, authorized_scopes: [] } } },
      { ...result, source_disclosures: { ...result.source_disclosures, [key]: projectSourceDisclosure({
        material_kind: "original_body", evaluated_as_of: "2026-10-10T00:00:00Z", proof_use: "source_only"
      }) } }];
    for (const input of variants) {
      const bound = { ...input, delivery_id: preparedDeliveryId(input.request_identity, input.index) };
      const raw = session.prepareRaw(bound)!, quote = raw.quote(rawFrame(bound), raw.members);
      const encoded = encodeSourceSemanticLibraryResponse(bound);
      expect(raw.initial.bytes).toBe(bytes(encoded));
      expect(quote.bytes).toBe(bytes(encoded));
      expect(quote.withinBudget).toBe("results" in encoded && encoded.results!.every(row => row.budget_state.within_budget));
      expect(bytes(session.materialize(bound).response)).toBe(bytes(encoded));
    }
    expect(bytes(session.materialize(variants[0]!).response)).not.toBe(before);
  } finally { session.close(); }
  expect(() => session.materialize(result)).toThrow(/session is closed/u);
});

it("quotes raw frames without serializing complete candidate envelopes", () => {
  const text = "shared\\\"🙂".repeat(100), session = createSourceSemanticLibraryEncoding(meter());
  const stringify = vi.spyOn(JSON, "stringify");
  try {
    const result = resultFor([text, "one"]);
    const sharedPosition = result.index.entries.findIndex(entry => result.previews![indexEntryCacheKey(entry)] === text);
    expect(sharedPosition).toBeGreaterThanOrEqual(0);
    const raw = session.prepareRaw(pageOf(result, [sharedPosition]))!;
    const entry = result.index.entries[1 - sharedPosition]!, key = indexEntryCacheKey(entry);
    for (const preview of ["one", "two", "three"]) {
      const member = raw.member({ entry, preview, source_disclosure: result.source_disclosures[key]! })!;
      raw.quote(rawFrame(result), sharedPosition === 0 ? [...raw.members, member] : [member, ...raw.members]);
    }
    const envelopes = () => stringify.mock.calls.filter(([value]) => value !== null && typeof value === "object"
      && "operation" in value && value.operation === "recall" && "results" in value);
    expect(envelopes()).toHaveLength(0);
    expect(stringify.mock.calls.filter(([value]) => value !== null && typeof value === "object"
      && "content_preview" in value && value.content_preview === text && "budget_state" in value)).toHaveLength(1);
    for (const suffix of ["one", "two", "three"]) JSON.stringify(encodeSourceSemanticLibraryResponse(resultFor([text, suffix])));
    expect(envelopes()).toHaveLength(3);
  } finally { session.close(); }
});

it.each([false, true])("meters actual materialization capture independently of output retention (proof=%s)", proof => {
  const result = resultFor(["Alice uses X."], proof), ledger = meter();
  const pending: unknown[] = [result];
  let checks = 0, keys = 0, containers = 0;
  while (pending.length > 0) {
    const value = pending.shift(); checks++;
    if (value === null || typeof value !== "object") continue;
    const values = Object.values(value); keys += values.length; containers++; pending.push(...values);
  }
  const session = createSourceSemanticLibraryEncoding(ledger);
  const materialized = session.materialize(result);
  expect(materialized.response).toEqual(encodeSourceSemanticLibraryResponse(result));
  expect(materialized.capture).toEqual({ work_units: 2 + checks + keys, memory_bytes: 128 + containers * 64 + keys * 16 });
  expect(ledger.spentWork).toBe(materialized.capture.work_units);
  expect(ledger.spentBytes).toBe(materialized.capture.memory_bytes);
  session.close();
  expect(() => session.materialize(result)).toThrow(/session is closed/u);
});

it("bounds materialization before proof/schema validation, keeps failed debits, and never invokes caller accessors", () => {
  const result = resultFor(["Alice uses X."], true), ledger = meter(), session = createSourceSemanticLibraryEncoding(ledger);
  const parse = vi.spyOn(SoulInterpretationResponseSchema, "parse");
  ledger.work = 5;
  expect(() => session.materialize(result)).toThrow(SourceSemanticResourceExhausted);
  expect(ledger.spentWork).toBeGreaterThan(0); expect(ledger.spentBytes).toBeGreaterThan(0);
  expect(parse).not.toHaveBeenCalled();
  const spent = ledger.spentBytes;
  session.close(); expect(ledger.spentBytes).toBe(spent);
  const getter = vi.fn(() => result.previews), unsafe = { ...result };
  Object.defineProperty(unsafe, "previews", { get: getter, enumerable: true });
  const next = createSourceSemanticLibraryEncoding(meter());
  try {
    expect(() => next.materialize(unsafe)).toThrow(/data properties/u);
    expect(getter).not.toHaveBeenCalled(); expect(parse).not.toHaveBeenCalled();
  } finally { next.close(); }
});

it("charges capture, validation, scans, component storage and quotes without refunding failed work", () => {
  const ledger = meter(), session = createSourceSemanticLibraryEncoding(ledger), result = resultFor();
  const afterTable = ledger.spentBytes;
  const raw = session.prepareRaw(result)!;
  raw.quote(rawFrame(result), raw.members);
  expect(ledger.spentBytes).toBeGreaterThan(afterTable);
  const spent = ledger.spentBytes;
  ledger.bytes = 1_000;
  expect(() => raw.quote(rawFrame(result), raw.members)).toThrow(SourceSemanticResourceExhausted);
  expect(ledger.spentBytes).toBeGreaterThan(spent);
  const failed = ledger.spentBytes;
  session.close(); expect(ledger.spentBytes).toBe(failed);
});

it("does not parse a raw index entry before funding its schema allocation", () => {
  const result = resultFor(["first", "second"]), ledger = meter();
  const session = createSourceSemanticLibraryEncoding(ledger);
  try {
    const raw = session.prepareRaw(singleton(result))!;
    const entry = result.index.entries[1]!, key = indexEntryCacheKey(entry);
    const parse = vi.spyOn(IndexEntrySchema, "parse");
    const spent = ledger.spentWork;
    denyNamedCharge(ledger, "library encoding raw entry schema allocation");
    expect(() => raw.member({ entry, preview: result.previews![key]!,
      source_disclosure: result.source_disclosures[key]! })).toThrow(SourceSemanticResourceExhausted);
    expect(parse).not.toHaveBeenCalled();
    expect(ledger.spentWork).toBeGreaterThan(spent);
  } finally { session.close(); }
});

it("does not stringify a raw frame before funding its allocated string", () => {
  const result = resultFor(), ledger = meter();
  const session = createSourceSemanticLibraryEncoding(ledger);
  try {
    const raw = session.prepareRaw(result)!;
    const order: string[] = [];
    const stringify = JSON.stringify.bind(JSON);
    vi.spyOn(JSON, "stringify").mockImplementation((value, ...rest) => {
      order.push("stringify");
      return stringify(value, ...rest);
    });
    denyNamedCharge(ledger, "library encoding frame bytes", order);
    expect(() => raw.quote(rawFrame(result), raw.members)).toThrow(SourceSemanticResourceExhausted);
    expect(order).toEqual(["charge"]);
    expect(ledger.spentWork).toBeGreaterThan(0);
  } finally { session.close(); }
});

it("does not stringify an escaped component before funding its allocation", () => {
  const result = resultFor(), ledger = meter();
  const session = createSourceSemanticLibraryEncoding(ledger);
  try {
    const seen: unknown[] = [];
    const stringify = JSON.stringify.bind(JSON);
    vi.spyOn(JSON, "stringify").mockImplementation((value, ...rest) => {
      seen.push(value);
      return stringify(value, ...rest);
    });
    denyNamedCharge(ledger, "library encoding escaped component");
    expect(() => session.prepareRaw(result)).toThrow(SourceSemanticResourceExhausted);
    expect(seen).not.toContain("truncated");
    expect(ledger.spentWork).toBeGreaterThan(0);
  } finally { session.close(); }
});
