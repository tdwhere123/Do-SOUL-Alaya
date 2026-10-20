import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); vi.restoreAllMocks(); });
afterAll(() => { isolation.restore(); });
import { SourceSemanticResourceExhausted, SoulInterpretationResponseSchema, SourceSemanticWorkerResultSchema, indexEntryCacheKey, sourceSemanticExecution, type SourceSemanticAccessReceipt, type SourceSemanticResourceBudget } from "@do-soul/alaya-protocol";
import { selectSourceSemanticLibraryPage, sourceSemanticLibrarySourceEntry, createSourceSemanticLibraryEncoding, encodeSourceSemanticLibraryResponse } from "@do-soul/alaya-core";
import { alternativeSelectionFixture, rawSourceTwin, selectionExecutionBudget }
  from "../../../../../../packages/core/src/__tests__/recall/runtime/source-semantic-selection-fixture.js";
import { measureNativeSubset, nativeSubsetContext, roomyDeliveryBytes } from "./source-semantic-library-subset-packing.test-support.js";
import { prepareSourceRecallDelivery, type SourceRecallMember } from "../../../runtime/recall-read-worker/source-recall-delivery.js";
import { SourceSemanticReadBudget } from "../../../runtime/field/source-semantic-read-stores.js";
import { SourceSemanticObserver } from "../../../runtime/recall-read-worker/source-semantic-observation.js";
import { deliverFrozenLibraryPage, prepareLibraryDelivery } from "../../../runtime/recall-read-worker/source-semantic-library-delivery.js";
import { createRecallReadWorkerClient } from "../../../runtime/recall/recall-read-worker-client.js";
import { builtWorkerUrl } from "./recall-read-worker-client-fixture.js";
import { withAccessLibrary, ACCESS_BUDGET, CLOCK, WS } from "./source-semantic-access.test-support.js";

it("removes complete candidate JSON allocations while preserving real SQLite raw delivery", async () => {
  const context = await nativeSubsetContext(alternativeSelectionFixture(selectionExecutionBudget));
  try {
    const raw = context.fixture.pool.map(rawSourceTwin);
    const exactObserver = new SourceSemanticObserver(1, { max_events: 2048, max_bytes: 524288 });
    const sharedObserver = new SourceSemanticObserver(2, { max_events: 2048, max_bytes: 524288 });
    const publicParse = vi.spyOn(SoulInterpretationResponseSchema, "parse"), workerParse = vi.spyOn(SourceSemanticWorkerResultSchema, "parse");
    const exact = measureNativeSubset(context, roomyDeliveryBytes, undefined, raw, input => selectSourceSemanticLibraryPage(input), exactObserver);
    const exactPublic = publicParse.mock.calls.length, exactWorker = workerParse.mock.calls.length;
    publicParse.mockClear(); workerParse.mockClear();
    const shared = measureNativeSubset(context, roomyDeliveryBytes, undefined, raw, selectSourceSemanticLibraryPage, sharedObserver);
    expect(shared.selected_roots).toEqual(exact.selected_roots);
    expect(shared.encoded.results).toEqual(exact.encoded.results);
    expect(publicParse.mock.calls.length).toBeLessThan(exactPublic);
    expect(workerParse.mock.calls.length).toBeLessThan(exactWorker);
    // One initial envelope and each new member are projected; later probes reuse
    // their evidence and validate only the page-specific frame and budget deltas.
    expect(shared.preparation_phases["candidate delivery encoding"]!.logical_bytes).toBeGreaterThan(0);
    expect(exact.preparation_phases["candidate delivery bytes"]!.logical_bytes).toBeGreaterThan(0);
    expect(shared.preparation_phases["candidate delivery bytes"]).toBeUndefined();
    expect(shared.preparation_phases["library encoding escaped component"]!.logical_bytes).toBeGreaterThan(0);
    expect(shared.preparation_work.logical_bytes).toBeLessThan(exact.preparation_work.logical_bytes);
    // Both dimensions include setup/capture/quotation costs. Unlike the earlier
    // string-cache-only path, reusable member evidence also saves work here.
    expect(shared.preparation_work.logical_work).toBeLessThan(exact.preparation_work.logical_work);
    process.stdout.write(`${JSON.stringify({ raw_component_encoding: { whole_page: exact.preparation_work,
      incremental: shared.preparation_work, whole_page_public_parses: exactPublic,
      incremental_public_parses: publicParse.mock.calls.length },
      scope: "finite authored SQLite fixture; cumulative logical costs, not physical savings" })}\n`);
    expect(shared.preparation_phases["library encoding input capture"]!.logical_bytes).toBeGreaterThan(0);
    expect(exact.preparation_phases["library encoding input capture"]!.logical_bytes).toBeGreaterThan(0);
    expect(shared.delivery_phases["library encoding input capture"]!.logical_bytes).toBeGreaterThan(0);
    const exactFacts = exactObserver.finish("success"), sharedFacts = sharedObserver.finish("success");
    expect(exactFacts.facts!.encodings.find(row => row.purpose === "candidate_page")!.encoder_invocations).toBeGreaterThan(0);
    expect(sharedFacts.facts!.encodings.filter(row => row.purpose === "candidate_page" || row.purpose === "candidate_partial_page")).toEqual([]);
    const quote = sharedFacts.facts!.encodings.find(row => row.purpose === "candidate_quote")!;
    expect(quote.encoder_invocations).toBeGreaterThan(0);
    expect(quote).toMatchObject({ count: 0, utf8_bytes: 0, identical_complete_encodings: 0 });
    expect(sharedFacts.diagnostics!.counts.encoding_attempt).toBe(1);
    expect(sharedFacts.diagnostics!.counts.encoding_result).toBeGreaterThan(1);
    expect(exactFacts.diagnostics!.counts.encoding_result).toBeGreaterThan(1);
    expect(sharedFacts.events.some(row => row.kind === "encoding_result" && row.phase !== "final_delivery"
      && (row.data as { variant?: string }).variant === "component_quote")).toBe(true);
    // Private encoding_result.bytes is the reserved envelope; actual encoded extent is separate.
    const final = sharedFacts.events.find(row => row.kind === "encoding_result" && row.phase === "final_delivery")!;
    const data = final.data as { bytes: number; encoded_bytes: number };
    expect(data.encoded_bytes).toBe(sharedFacts.facts!.encodings.find(row => row.purpose === "base_page")!.utf8_bytes);
    expect(data.bytes).toBeGreaterThanOrEqual(data.encoded_bytes);
    expect(data.bytes).toBe(exact.reserved_bytes);
    expect(sharedFacts.facts!.encodings.find(row => row.purpose === "candidate_initial_projection")!.encoder_invocations).toBe(1);
    expect(sharedFacts.facts!.encodings.find(row => row.purpose === "raw_component_projection")!.encoder_invocations).toBe(raw.length);
  } finally { await context.close(); }
});

it("keeps exact and adjacent raw envelope boundaries equal to complete public encoding", async () => {
  const context = await nativeSubsetContext(alternativeSelectionFixture(selectionExecutionBudget));
  try {
    const raw = context.fixture.pool.map(rawSourceTwin);
    const oracle = measureNativeSubset(context, roomyDeliveryBytes, raw, raw);
    expect(oracle.reserved_bytes).not.toBeNull();
    for (const limit of [oracle.reserved_bytes!, oracle.reserved_bytes! - 1]) {
      const exact = measureNativeSubset(context, limit, undefined, raw, input => selectSourceSemanticLibraryPage(input));
      const observer = new SourceSemanticObserver(4, { max_events: 2048, max_bytes: 524288 });
      const shared = measureNativeSubset(context, limit, undefined, raw, selectSourceSemanticLibraryPage, observer);
      expect(shared.plan.pages.map(page => page.map(row => row.entry.target))).toEqual(exact.plan.pages.map(page => page.map(row => row.entry.target)));
      expect(shared.encoded.results).toEqual(exact.encoded.results);
      expect(shared.encoded_bytes).toBeLessThanOrEqual(limit);
      const final = observer.finish("success").events.find(row => row.kind === "encoding_result" && row.phase === "final_delivery")!;
      expect((final.data as { bytes: number }).bytes).toBeLessThanOrEqual(limit);
      if (limit === oracle.reserved_bytes) expect(shared.plan.pages[0]).toHaveLength(raw.length);
    }
  } finally { await context.close(); }
});

it("retains same-root raw fallback when an atomic proof fits bytes but exceeds actual token admission", async () => {
  const context = await nativeSubsetContext(alternativeSelectionFixture(selectionExecutionBudget));
  try {
    const proof = context.fixture.pool[0]!, raw = rawSourceTwin(proof);
    const result = measureNativeSubset(context, roomyDeliveryBytes, undefined, [{ ...proof, preview: "x".repeat(8_004) }, raw]);
    expect(result.plan.pages.flat()).toHaveLength(1);
    expect(result.plan.pages[0]![0]!.proofs).toHaveLength(0);
    expect(result.native.proofs).toBeUndefined();
    expect(result.encoded.results![0]!.content_preview).toBe(raw.preview);
    expect(result.encoded.results![0]!.budget_state.within_budget).toBe(true);
    expect(result.preparation_phases["candidate delivery bytes"]!.logical_bytes).toBeGreaterThan(0);
    expect(result.preparation_phases["library encoding input check"]!.logical_work).toBeGreaterThan(0);
    expect(result.preparation_phases["library encoding input capture"]!.logical_bytes).toBeGreaterThan(0);
    expect(result.delivery_phases["library encoding input capture"]!.logical_bytes).toBeGreaterThan(0);
    const supported = measureNativeSubset(context, roomyDeliveryBytes, undefined, [proof]);
    expect(supported.native.proofs).toEqual(proof.proofs);
    expect(supported.delivery_phases["library encoding input capture"]!.logical_bytes)
      .toBeGreaterThan(result.delivery_phases["library encoding input capture"]!.logical_bytes);
  } finally { await context.close(); }
});

it("rejects oversized final payload support independently of a roomy byte envelope, then retries the frozen plan", async () => {
  const context = await nativeSubsetContext(alternativeSelectionFixture(selectionExecutionBudget));
  try {
    const row = rawSourceTwin(context.fixture.pool[0]!);
    const measured = measureNativeSubset(context, roomyDeliveryBytes, undefined, [row]);
    const changed = { ...measured.plan, pages: measured.plan.pages.map(page => page.map(member => ({ ...member, preview: "x".repeat(8_004) }))) };
    const payload = { workspace_id: "ws", as_of: measured.plan.as_of,
      authorized_scopes: { mode: "named" as const, scopes: ["project"] }, request: measured.request };
    const failed = new SourceSemanticReadBudget(selectionExecutionBudget);
    expect(() => deliverFrozenLibraryPage(measured.delivery_runtime, payload, failed, measured.request, changed, 0))
      .toThrow(/failed payload admission/u);
    const spent = failed.spentWork;
    expect(spent).toBeGreaterThan(0);
    const recovered = deliverFrozenLibraryPage(measured.delivery_runtime, payload, new SourceSemanticReadBudget(selectionExecutionBudget),
      measured.request, measured.plan, 0);
    expect(recovered.index).toEqual(measured.native.index);
    expect(failed.spentWork).toBe(spent);
  } finally { await context.close(); }
});

it("keeps authoritative receipt refinements and capture prices when reusing owned raw access evidence", async () => {
  const context = await nativeSubsetContext(alternativeSelectionFixture(selectionExecutionBudget));
  try {
    const result = measureNativeSubset(context, roomyDeliveryBytes, undefined, context.fixture.pool.map(rawSourceTwin));
    const input = result.native, access = input.discovery.access!;
    const meter = new SourceSemanticReadBudget(selectionExecutionBudget), session = createSourceSemanticLibraryEncoding(meter);
    try {
      const raw = session.prepareRaw(input)!;
      const frame = { index: { completeness: input.index.completeness, continuation: input.index.continuation, order_status: input.index.order_status },
        access: { source_order: access.source_candidates.map(source => input.index.entries.findIndex(entry =>
          entry.target.kind === "source_evidence" && entry.target.root_id === source.record_id)), trace: access.trace },
        slot_qualifiers: input.slot_qualifiers, payload: input.coverage.payload, execution: "initial" as const };
      const quote = raw.quote(frame, raw.members);
      expect(quote.bytes).toBe(Buffer.byteLength(JSON.stringify(encodeSourceSemanticLibraryResponse(input))));
      expect(quote.capture).toEqual(session.materialize(input).capture);
      const entry = input.index.entries[0]!, source = access.source_candidates.find(row =>
        entry.target.kind === "source_evidence" && row.record_id === entry.target.root_id)!;
      const key = indexEntryCacheKey(entry);
      const good = raw.member({ entry, preview: input.previews![key]!, source_disclosure: input.source_disclosures[key]!, source_access: source })!;
      const replaced = raw.quote(frame, [good, ...raw.members.slice(1)]);
      expect(replaced.bytes).toBe(quote.bytes); expect(replaced.capture).toEqual(quote.capture);
      const bad = raw.member({ entry, preview: input.previews![key]!, source_disclosure: input.source_disclosures[key]!,
        source_access: { ...source, read_bytes: source.body_bytes! + 1 } })!;
      const before = meter.spentWork;
      expect(() => raw.quote(frame, [bad, ...raw.members.slice(1)])).toThrow(/extent|completeness/u);
      expect(meter.spentWork).toBeGreaterThan(before);
      expect(raw.quote(frame, raw.members).bytes).toBe(quote.bytes);
    } finally { session.close(); }
  } finally { await context.close(); }
});

it("retains five facts under the unchanged work-tight native allowance", async () => {
  await withAccessLibrary(Array.from({ length: 5 }, (_, position) => ({ id: `item-cost-${position + 1}`,
    text: `Item ${position + 1} costs ${(position + 1) * 10} dollars.`, eventTime: "2024-02-03T04:05:06.0000007Z" })), async ({ filename }) => {
    const client = createRecallReadWorkerClient({ databaseFilename: filename, workerCount: 1,
      workerUrl: builtWorkerUrl })!;
    try {
      await client.ready();
      const observed = await client.observeSourceSemantics({}, () => client.sourceSemanticsPort!.execute({ workspace_id: WS,
        as_of: CLOCK, authorized_scopes: { mode: "named", scopes: ["project"] }, request: { kind: "recall",
          accepts_unreviewed_conditional_results: true, original_query: "What is the total cost of items 1 through 5?",
          semantic_correspondences: [], budget: { ...ACCESS_BUDGET, work_units: 20_000, memory_bytes: 1_500_000 }, output_byte_limit: 19_392 } }));
      if (observed.outcome.status !== "success") throw observed.outcome.error;
      const result = observed.outcome.value;
      if (result.kind !== "recall") throw new Error("raw recall expected");
      expect(result.index.entries, JSON.stringify({ costs: observed.observations[0]!.costs,
        meters: observed.observations[0]!.meters })).toHaveLength(5);
      expect(result.index.continuation).toBeNull();
      expect(result.work.logical_work).toBeLessThanOrEqual(20_000);
    } finally { await client.close(); }
  });
});

it("meters initial and continuation capture through the current owners in a reopened SQLite worker", async () => {
  await withAccessLibrary(Array.from({ length: 6 }, (_, position) => ({ id: `source-${position}`, text: `Source fact ${position}.` })),
    async ({ filename }) => {
      const client = createRecallReadWorkerClient({ databaseFilename: filename, workerCount: 1,
        workerUrl: builtWorkerUrl })!;
      try {
        await client.ready();
        const request = { kind: "recall" as const, accepts_unreviewed_conditional_results: true as const,
          original_query: "What are the source facts?", semantic_correspondences: [], budget: ACCESS_BUDGET, output_byte_limit: 1_000_000 };
        const payload = { workspace_id: WS, as_of: CLOCK, authorized_scopes: { mode: "named" as const, scopes: ["project"] }, request };
        const first = await client.observeSourceSemantics({}, () => client.sourceSemanticsPort!.execute(payload));
        if (first.outcome.status !== "success") throw first.outcome.error;
        const page = first.outcome.value;
        if (page.kind !== "recall" || page.index.continuation === null) throw new Error("frozen source continuation expected");
        expect(page.index.entries).toHaveLength(5);
        for (const phase of ["selection", "request"]) {
          expect(first.observations[0]!.costs.find(cost => cost.phase === phase
            && cost.reason === "library encoding input capture" && cost.operation === "debit")!.bytes).toBeGreaterThan(0);
        }
        const continued = { ...payload, request: { ...request, continuation: page.index.continuation } };
        const attempts = [];
        for (let attempt = 0; attempt < 2; attempt++) {
          const observed = await client.observeSourceSemantics({}, () => client.sourceSemanticsPort!.execute(continued));
          if (observed.outcome.status !== "success") throw observed.outcome.error;
          const value = observed.outcome.value;
          if (value.kind !== "recall") throw new Error("continued recall expected");
          expect(value.index.entries).toHaveLength(1); expect(value.index.continuation).toBeNull();
          expect(value.work.native_work).toBe(0); expect(value.work.native_bytes).toBe(0);
          expect(observed.observations[0]!.costs.find(cost => cost.reason === "library encoding materialization record"
            && cost.operation === "debit")).toMatchObject({ phase: "request", count: 1, work: 2, bytes: 128 });
          expect(observed.observations[0]!.costs.find(cost => cost.reason === "library encoding input capture"
            && cost.operation === "debit")!.bytes).toBeGreaterThan(0);
          attempts.push(value);
        }
        expect(attempts[1]!.index).toEqual(attempts[0]!.index);
        expect(attempts[1]!.delivery_id).toBe(attempts[0]!.delivery_id);
      } finally { await client.close(); }
    });
});

it("holds actual capture completion while a later raw component exhausts work, preserving the native incumbent", async () => {
  const context = await nativeSubsetContext(alternativeSelectionFixture(selectionExecutionBudget));
  try {
    const raw = context.fixture.pool.map(rawSourceTwin);
    const calibration = measureNativeSubset(context, roomyDeliveryBytes, undefined, raw);
    const first = calibration.completion_holds[0]!;
    expect(first.cost.work_units).toBeGreaterThan(0);
    const work_units = first.spent_work + first.cost.work_units + Math.floor(first.cost.work_units / 2);
    const tight = measureNativeSubset(context, roomyDeliveryBytes, undefined, raw, selectSourceSemanticLibraryPage, undefined,
      { work_units, memory_bytes: selectionExecutionBudget.memory_bytes });
    expect(tight.plan.pages[0]).toHaveLength(1);
    expect(tight.native.index.entries[0]!.target).toEqual(calibration.native.index.entries[0]!.target);
    expect(tight.budget_rejections.some(row => row.phase === "library encoding raw member evidence"),
      JSON.stringify(tight.budget_rejections)).toBe(true);
    expect(tight.completion_holds[0]!.cost).toEqual(first.cost);
    expect(tight.preparation_remaining.work_units).toBeGreaterThanOrEqual(first.cost.work_units);
    expect(tight.delivery_phases["library encoding input check"]!.logical_work).toBeGreaterThan(0);
    // Absorb the actual work-tight selection child, then execute final delivery
    // under the existing half-budget split, including the new capture debit.
    const parent = new SourceSemanticReadBudget({ work_units: 2 * work_units,
      memory_bytes: 2 * selectionExecutionBudget.memory_bytes });
    parent.absorb(tight.preparation_meter);
    const finalized = deliverFrozenLibraryPage(tight.delivery_runtime, { workspace_id: "ws", as_of: tight.plan.as_of,
      authorized_scopes: { mode: "named", scopes: ["project"] }, request: tight.request },
    parent, tight.request, tight.plan, 0);
    expect(finalized.index.entries).toEqual(tight.native.index.entries);
    expect(parent.spentWork).toBeLessThanOrEqual(2 * work_units);
    expect(tight.encoded.results![0]!.budget_state.within_budget).toBe(true);
  } finally { await context.close(); }
});

it("uses parent headroom for capture while refusing an unfunded same-meter fallback", async () => {
  const context = await nativeSubsetContext(alternativeSelectionFixture(selectionExecutionBudget));
  try {
    const raw = context.fixture.pool.map(rawSourceTwin);
    const originalHold = SourceSemanticReadBudget.prototype.hold;
    const captures: { cost: SourceSemanticResourceBudget; spent_work: number; spent_bytes: number }[] = [];
    vi.spyOn(SourceSemanticReadBudget.prototype, "hold").mockImplementation(function (this: SourceSemanticReadBudget, cost) {
      captures.push({ cost, spent_work: this.spentWork, spent_bytes: this.spentBytes });
      return originalHold.call(this, cost);
    });
    const calibration = measureNativeSubset(context, roomyDeliveryBytes, undefined, raw);
    const first = captures[0]!;
    expect(first.cost.work_units).toBeGreaterThan(0);
    expect(first.spent_work).toBeGreaterThanOrEqual(first.cost.work_units);
    const childBudget = { work_units: first.spent_work, memory_bytes: first.spent_bytes };
    const parentBudget = {
      work_units: childBudget.work_units + first.cost.work_units + selectionExecutionBudget.work_units,
      memory_bytes: childBudget.memory_bytes + first.cost.memory_bytes + selectionExecutionBudget.memory_bytes };
    expect(parentBudget.work_units - childBudget.work_units).toBeGreaterThanOrEqual(first.cost.work_units);
    const { pages: _pages, page_access: _access, ...planBase } = calibration.plan;
    const base = { ...planBase, pool: context.pool };
    const parent = new SourceSemanticReadBudget(parentBudget);
    const selection = new SourceSemanticReadBudget(childBudget, undefined, "selection");
    const plan = prepareLibraryDelivery(base, raw, calibration.request, parent, "field",
      selectSourceSemanticLibraryPage, sourceSemanticExecution(), selection);
    expect(plan.pages[0]!.length).toBeGreaterThan(0);
    expect(plan.pages[0]![0]!.entry.target).toEqual(calibration.native.index.entries[0]!.target);
    const finalized = deliverFrozenLibraryPage(calibration.delivery_runtime, { workspace_id: "ws", as_of: plan.as_of,
      authorized_scopes: { mode: "named", scopes: ["project"] }, request: calibration.request },
    parent, calibration.request, plan, 0);
    expect(finalized.index.entries[0]!.target).toEqual(calibration.native.index.entries[0]!.target);
    expect(finalized.slot_qualifiers.every((_, index) => finalized.index.entries[index] !== undefined)).toBe(true);
    // Without a distinct finalization allowance, the consumed selection budget
    // cannot fund even empty access evidence. Exhaustion is not a valid-empty page.
    const sameMeter = new SourceSemanticReadBudget(childBudget);
    let rejected: unknown;
    try {
      prepareLibraryDelivery(base, raw, calibration.request, sameMeter, "field",
        selectSourceSemanticLibraryPage, sourceSemanticExecution());
    } catch (error) { rejected = error; }
    expect(rejected).toBeInstanceOf(SourceSemanticResourceExhausted);
    expect(rejected).toHaveProperty("message", "source semantic access trace delivery budget exhausted");
    expect(sameMeter.remaining()).toEqual({ work_units: childBudget.work_units - sameMeter.spentWork,
      memory_bytes: childBudget.memory_bytes - sameMeter.spentBytes });
  } finally { await context.close(); }
});

it("debits frozen continuation capture on every attempt without native reads or changed membership", async () => {
  const context = await nativeSubsetContext(alternativeSelectionFixture(selectionExecutionBudget));
  try {
    const raw = context.fixture.pool.map(rawSourceTwin);
    const singleton = measureNativeSubset(context, roomyDeliveryBytes, [raw[0]!], raw);
    const split = measureNativeSubset(context, singleton.reserved_bytes!, undefined, raw);
    expect(split.plan.pages.length).toBeGreaterThan(1);
    const observer = new SourceSemanticObserver(3, { max_events: 2048, max_bytes: 524288 });
    let beforeCapture = 0;
    class ContinuationMeter extends SourceSemanticReadBudget {
      override charge(work: number, bytes: number, reason?: string): void {
        if (reason === "library encoding materialization record") beforeCapture = this.spentWork;
        super.charge(work, bytes, reason);
      }
    }
    const pages = [0, 1].map(() => {
      const meter = new ContinuationMeter(selectionExecutionBudget, observer);
      const page = deliverFrozenLibraryPage(split.delivery_runtime, { workspace_id: "ws", as_of: split.plan.as_of,
        authorized_scopes: { mode: "named", scopes: ["project"] }, request: split.request },
      meter, split.request, split.plan, split.plan.pages[0]!.length);
      expect(meter.nativeWork).toBe(0); expect(meter.nativeBytes).toBe(0);
      return page;
    });
    expect(pages[1]!.index).toEqual(pages[0]!.index);
    expect(pages[1]!.delivery_id).toBe(pages[0]!.delivery_id);
    const exhausted = new SourceSemanticReadBudget({ work_units: beforeCapture + 3,
      memory_bytes: selectionExecutionBudget.memory_bytes });
    expect(() => deliverFrozenLibraryPage(split.delivery_runtime, { workspace_id: "ws", as_of: split.plan.as_of,
      authorized_scopes: { mode: "named", scopes: ["project"] }, request: split.request },
    exhausted, split.request, split.plan, split.plan.pages[0]!.length)).toThrow(/library encoding input capture/u);
    const spent = exhausted.spentWork;
    expect(spent).toBe(beforeCapture + 3);
    const recovered = deliverFrozenLibraryPage(split.delivery_runtime, { workspace_id: "ws", as_of: split.plan.as_of,
      authorized_scopes: { mode: "named", scopes: ["project"] }, request: split.request },
    new SourceSemanticReadBudget(selectionExecutionBudget), split.request, split.plan, split.plan.pages[0]!.length);
    expect(recovered.index).toEqual(pages[0]!.index); expect(exhausted.spentWork).toBe(spent);
    const row = observer.finish("success");
    const checks = row.costs.find(cost => cost.reason === "library encoding input check" && cost.operation === "debit")!;
    const captures = row.costs.find(cost => cost.reason === "library encoding input capture" && cost.operation === "debit")!;
    expect(checks.work).toBeGreaterThan(0); expect(captures.bytes).toBeGreaterThan(0);
    expect(row.costs.find(cost => cost.reason === "library encoding materialization record" && cost.operation === "debit"))
      .toMatchObject({ count: 2, work: 4, bytes: 256 });
    expect(row.facts!.encodings.find(encoding => encoding.purpose === "base_page")!.encoder_invocations).toBe(2);
  } finally { await context.close(); }
});

type Delivery = Parameters<typeof prepareSourceRecallDelivery>[0];
function deliveryHarness() {
  const meter = new SourceSemanticReadBudget(selectionExecutionBudget), pages: SourceRecallMember[][] = [];
  const receipts: SourceSemanticAccessReceipt[] = [], access = {} as SourceSemanticAccessReceipt;
  const input: Delivery = { meter, count: 2, byteLimit: 100, initialExecutionDiffers: false, order: "source_access", improve: false,
    root: member => `root-${member}`, target: () => sourceSemanticLibrarySourceEntry({ workspaceId: "ws", root_id: "record",
      source_version: "1", content_digest: `sha256:${"a".repeat(64)}`, evidence_object_id: null, hypothesis_id: "library" }).target,
    supportCount: () => 0,
    accessPosition: member => member, pageKey: page => JSON.stringify(page),
    select: ({ fits }) => { const page = [{ member: 0 }]; return fits(page) ? page : []; },
    improvePage: () => [], pairs: function* () {},
    encode: () => ({ encoding: "completion_quote", access, bytes: 90, withinBudget: true, payloadGrowth: 0 }), finishEncoding: () => {},
    append: (page, receipt) => { pages.push([...page]); receipts.push(receipt); },
    replace: (position, page, receipt) => { pages[position] = [...page]; receipts[position] = receipt; },
    pageCount: () => pages.length, pageLength: position => pages[position]!.length };
  return { input, pages, receipts, access };
}

it("preserves an admitted incumbent when the next exact quote exhausts after a cheap check", () => {
  const { input, pages, receipts, access } = deliveryHarness();
  let attempts = 0, finishes = 0;
  const incomplete = prepareSourceRecallDelivery({ ...input, count: 1,
    select: ({ fits }) => {
      const incumbent = [{ member: 0 }];
      expect(fits(incumbent)).toBe(true);
      try { fits([{ member: 0 }, { member: 1 }]); }
      catch (error) { expect(error).toBeInstanceOf(SourceSemanticResourceExhausted); }
      return incumbent;
    },
    encode: () => {
      input.meter.charge(1, 16, "quote component check");
      if (++attempts > 1) throw new SourceSemanticResourceExhausted("exact quote completion");
      return { encoding: "completion_quote", access, bytes: 90, withinBudget: true, payloadGrowth: 0 };
    }, finishEncoding: () => { finishes++; } });
  expect(incomplete).toBe(false);
  expect(pages).toEqual([[{ member: 0 }]]); expect(receipts).toEqual([access]);
  expect(finishes).toBe(2); expect(input.meter.spentBytes).toBeGreaterThan(32);
});

it("does not reuse admission across changed pairs sharing an extra or negative incumbent ordinal", () => {
  const { input, pages, receipts, access } = deliveryHarness();
  let generation = 0;
  const first = { ...access, pool_id: "first" }, second = { ...access, pool_id: "second" };
  prepareSourceRecallDelivery({ ...input, count: 1, improve: true,
    pairs: function* () { generation = 1; yield 1; generation = 2; yield 1; },
    improvePage: (_position, candidate, fits) => {
      const proposed = [{ member: -1 }, { member: candidate }];
      return fits(proposed) ? proposed : pages[0]!;
    },
    encode: page => ({ encoding: "completion_quote", access: generation === 0 ? access : generation === 1 ? first : second,
      bytes: generation === 2 ? 101 : page.length * 40, withinBudget: true, payloadGrowth: 0 }) });
  expect(pages).toEqual([[{ member: -1 }, { member: 1 }]]);
  expect(receipts).toEqual([first]);
});
