import { expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { SourceSemanticResourceLedger, SourceSemanticResourceExhausted,
  UNKNOWN_UTTERANCE_ATTRIBUTION, type SourceSemanticResourceBudget } from "@do-soul/alaya-protocol";
import { SqliteEventLogRepo, SqliteEvidenceCapsuleRepo, SqliteFieldSourceRecordRepo } from "@do-soul/alaya-storage";
import { withAccessLibrary, WS, type AccessFixtureSource, type PublicationBoundary } from
  "../../../../../core-daemon/src/__tests__/runtime/recall/source-semantic-access.test-support.js";
import { eventDraft, executionBinding, readHealthyManifest } from "./field-obligation-rediscovery.test-support.js";

const BUDGET = { work_units: 200_000, memory_bytes: 8_000_000 };
const LIMITS = { diagnostic_events: 100_000, source_read_calls: 256, returned_source_body_bytes: 1_048_576 };
const INPUTS = [
  { id: "collection-01/document-00", bytes: 118, at: "2026-09-17T23:59:00.000Z",
    text: "Cargo J9 was sent. Vega promised to inspect J9. Dispatch records are under Cedar. Inspection records are under Harbor.",
    content_digest: "sha256:09474286c3c91c14aa80cd77011ae2fcab45c388869a0167aaf1b428132c29ee",
    interpretation_id: "sha256:69b72d8a73def2357c1a2af878625efcff11cd213a0a619f5d165854451025fc",
    record_id: "sha256:035793390bb9f3e10cb1fb19ea8498327445661662f5edceca8afc8977aff7fb" },
  { id: "collection-01/document-01", bytes: 243, at: "2026-09-17T23:59:01.000Z",
    text: "Manifest R01. Cargo P01 was sent. Carrier: Westline. Origin: North Quay. Destination: East Yard. Container: CT01. Seal: SL01. The outbound desk signed after loading. This record contains no inspection result. Inspection status remains unknown.",
    content_digest: "sha256:a7f39295e7b2d9d45d5499eb11ea9d9f857f20e94c87ffc646cabdd390b83a8e",
    interpretation_id: "sha256:6714c9707e34312f4a3ec0aa0837f2d5b75690716fafe72e660445f498a0ca06",
    record_id: "sha256:806acd1c3c6317e273ee9ae560b6ea6550caeafa2ada58b73f12460552075f6c" }
] as const;
type Usage = { work_units: number; memory_bytes: number };
type End = Extract<PublicationBoundary, { kind: "end" }>;
type SourceRow = ReturnType<SqliteFieldSourceRecordRepo["findById"]>;
type Stop = { status: "attribution_unavailable" | "diagnostic_exhausted" | "resource_exhausted"
  | "identity_mismatch" | "unexpected_effect" | "publication_failed"; reason: string };
type Publication = { source_id: string; publication_index: number; before: Usage; leaf_debits: Usage;
  labels: Map<string, Usage & { invocations: number }>; end: End | null };

function spent(meter: SourceSemanticResourceLedger): Usage {
  return { work_units: meter.spentWork, memory_bytes: meter.spentBytes };
}
function add(target: Usage, value: SourceSemanticResourceBudget): void {
  target.work_units += value.work_units; target.memory_bytes += value.memory_bytes;
}
function difference(after: Usage, before: Usage): Usage {
  return { work_units: after.work_units - before.work_units, memory_bytes: after.memory_bytes - before.memory_bytes };
}
type Failure = { name?: string; message?: string; phase?: string; thrown?: string; errors?: Failure[]; cause?: Failure };
function failure(error: unknown): Failure {
  return error instanceof Error ? { name: error.name, message: error.message,
    ...(error instanceof SourceSemanticResourceExhausted ? { phase: error.phase } : {}),
    ...(error instanceof AggregateError ? { errors: error.errors.map(failure),
      ...(error.cause === undefined ? {} : { cause: failure(error.cause) }) } : {}) } : { thrown: String(error) };
}

class PublicationObserver {
  readonly events: Record<string, unknown>[] = [];
  readonly publications: Publication[] = [];
  readonly reads = new Map<string, { scope: string; source_id: string | null; method: string;
    calls: number; rows: number; nulls: number; errors: number; returned_body_bytes: number; unavailable_bodies: number }>();
  readonly stops: Stop[] = [];
  readonly dispatchStop = new Error("publication observation stopped before further dispatch");
  meter: SourceSemanticResourceLedger | undefined;
  active: Publication | null = null;
  filename: string | null = null;
  manifest: ReturnType<typeof readHealthyManifest> | null = null;
  manifestSequence: number | null = null;
  manifestReads = 0;
  sequence = 0;
  omittedEvents = 0;
  sourceReadCalls = 0;
  sourceBodyBytes = 0;

  stop(status: Stop["status"], reason: string): void {
    if (!this.stops.some(row => row.status === status && row.reason === reason)) this.stops.push({ status, reason });
  }
  record(kind: string, detail: Record<string, unknown> = {}): void {
    const sequence = ++this.sequence;
    if (this.events.length >= LIMITS.diagnostic_events) {
      this.omittedEvents++; this.stop("diagnostic_exhausted", "diagnostic event ceiling"); return;
    }
    this.events.push({ sequence, kind, publication_source_id: this.active?.source_id ?? null, ...detail });
  }
  boundary(event: PublicationBoundary): void {
    if (event.kind === "begin") {
      if (this.stops.length > 0) {
        this.captureManifest();
        this.record("publication_dispatch_stopped", { source_id: event.source_id, publication_index: event.publication_index });
        throw this.dispatchStop;
      }
      if (this.active !== null || event.meter === undefined || (this.meter !== undefined && event.meter !== this.meter)) {
        this.stop("attribution_unavailable", "publication boundary or shared meter unavailable"); throw this.dispatchStop;
      }
      if (event.source_id !== INPUTS[this.publications.length]?.id || event.publication_index !== 0) {
        this.stop("unexpected_effect", "unregistered publication dispatch"); throw this.dispatchStop;
      }
      this.meter = event.meter;
      this.active = { source_id: event.source_id, publication_index: event.publication_index, before: spent(event.meter),
        leaf_debits: { work_units: 0, memory_bytes: 0 }, labels: new Map(), end: null };
      this.publications.push(this.active); this.record("publication_begin", { spent: spent(event.meter) });
      return;
    }
    const publication = this.active;
    if (publication === null || publication.source_id !== event.source_id || event.meter !== this.meter) {
      this.stop("attribution_unavailable", "publication end has no matching begin"); return;
    }
    publication.end = event;
    if (!isDeepStrictEqual(publication.leaf_debits, event.usage)
      || !isDeepStrictEqual(event.usage, difference(spent(this.meter!), publication.before))) {
      this.stop("attribution_unavailable", "leaf debits do not reconcile to publication delta");
    }
    this.record("publication_end", { usage: event.usage, outcome: event.outcome.status,
      ...(event.outcome.status === "failed" ? { error: failure(event.outcome.error) } : {}) });
    this.active = null;
    if (event.outcome.status === "failed") {
      this.stop(event.outcome.error instanceof SourceSemanticResourceExhausted ? "resource_exhausted" : "publication_failed",
        failure(event.outcome.error).message ?? "native publication failed");
    } else this.checkIdentity(publication, event.outcome.result);
    this.captureManifest();
  }
  debit(meter: SourceSemanticResourceLedger, phase: string, before: Usage): void {
    if (meter !== this.meter) return;
    const delta = difference(spent(meter), before), publication = this.active;
    if (publication === null) { this.stop("attribution_unavailable", "shared meter debit outside publication"); return; }
    if (phase.length === 0) this.stop("attribution_unavailable", "empty native debit label");
    add(publication.leaf_debits, delta);
    const label = publication.labels.get(phase) ?? { work_units: 0, memory_bytes: 0, invocations: 0 };
    add(label, delta); label.invocations++; publication.labels.set(phase, label);
    this.record("charge", { phase, ...delta });
  }
  read(method: "findCurrent" | "findById", workspaceId: string, requestedId: string,
    row: SourceRow | undefined, error?: unknown): void {
    const expected = INPUTS.find(input => method === "findCurrent" ? input.id === requestedId : input.record_id === requestedId);
    const sourceId = row?.source_id ?? expected?.id ?? null;
    const scope = this.active === null ? "outside_publication" : "publication";
    const key = `${scope}/${sourceId}/${method}`;
    const count = this.reads.get(key) ?? { scope, source_id: sourceId, method, calls: 0, rows: 0, nulls: 0,
      errors: 0, returned_body_bytes: 0, unavailable_bodies: 0 };
    const bytes = row?.source_body == null ? null : Buffer.byteLength(row.source_body);
    count.calls++; this.sourceReadCalls++;
    if (row === undefined) count.errors++;
    else if (row === null) count.nulls++;
    else { count.rows++; if (bytes === null) count.unavailable_bodies++; else count.returned_body_bytes += bytes; }
    this.sourceBodyBytes += bytes ?? 0; this.reads.set(key, count);
    this.record("source_read", { method, scope, workspace_id: workspaceId, requested_id: requestedId,
      source_id: sourceId, returned_record_id: row?.record_id ?? null, content_digest: row?.content_digest ?? null,
      outcome: row === undefined ? "error" : row === null ? "null" : "row", returned_body_bytes: bytes,
      ...(row === undefined ? { error: failure(error) } : {}) });
    if (sourceId === null || workspaceId !== WS || (this.active !== null && this.active.source_id !== sourceId)) {
      this.stop("attribution_unavailable", "source read ownership unavailable");
    }
    if (row != null && (expected === undefined || row.record_id !== expected.record_id || row.source_id !== expected.id
      || row.content_digest !== expected.content_digest || row.source_body !== expected.text || row.source_version !== "1"
      || row.recorded_at !== expected.at || row.event_time !== null || row.scope_class !== "project")) {
      this.stop("identity_mismatch", "returned source record differs from frozen input");
    }
    if (this.sourceReadCalls > LIMITS.source_read_calls || this.sourceBodyBytes > LIMITS.returned_source_body_bytes) {
      this.stop("diagnostic_exhausted", "source repository read ceiling");
    }
  }
  checkIdentity(publication: Publication, result: Extract<End["outcome"], { status: "published" }>["result"]): void {
    const input = INPUTS.find(row => row.id === publication.source_id), h = result.bound.interpretation;
    if (input === undefined || result.bound.interpretation_id !== input.interpretation_id
      || h.source.content_digest !== input.content_digest || h.source.source_id !== input.id || h.source.source_version !== "1"
      || h.producer_id !== "access-test-author" || h.producer_version !== "p0" || h.normalizer_version !== "source-semantic-normalizer-v5"
      || !isDeepStrictEqual(h.source.attribution_context, UNKNOWN_UTTERANCE_ATTRIBUTION)
      || result.evidence.created_at !== input.at || result.evidence.lifecycle_state !== "active") {
      this.stop("identity_mismatch", "native publication differs from retained identity or qualifications");
    }
    if (!isDeepStrictEqual(result.resource_usage, spent(this.meter!))) {
      this.stop("attribution_unavailable", "publisher cumulative receipt differs from shared meter");
    }
  }
  captureManifest(): void {
    if (this.filename === null) { this.stop("attribution_unavailable", "native database identity unavailable"); return; }
    try { this.manifestReads++; this.manifest = readHealthyManifest(this.filename); this.manifestSequence = this.sequence; }
    catch (error) { this.stop("attribution_unavailable", `persistent effects unreadable: ${failure(error).message}`); }
  }
}

function observeLedger(observer: PublicationObserver) {
  const prototype = SourceSemanticResourceLedger.prototype;
  const charge = prototype.charge, reserve = prototype.reserve, retain = prototype.retain;
  const chargeSpy = vi.spyOn(prototype, "charge").mockImplementation(function (this: SourceSemanticResourceLedger, work, bytes, phase = "preparation") {
    const before = spent(this);
    const result = charge.call(this, work, bytes, phase);
    observer.debit(this, phase, before);
    return result;
  });
  const reserveSpy = vi.spyOn(prototype, "reserve").mockImplementation(function (this: SourceSemanticResourceLedger, work, bytes, phase = "preparation") {
    try { return reserve.call(this, work, bytes, phase); }
    catch (error) {
      if (this === observer.meter) observer.record("reserve_failed", { phase, requested_work: work,
        requested_bytes: bytes, error: failure(error) });
      throw error;
    }
  });
  const retainSpy = vi.spyOn(prototype, "retain").mockImplementation(function (this: SourceSemanticResourceLedger, value, phase = "preparation") {
    const observed = this === observer.meter, before = spent(this);
    let outcome = "returned";
    if (observed) observer.record("retain_begin", { phase });
    try { return retain.call(this, value, phase); }
    catch (error) { outcome = "threw"; throw error; }
    finally { if (observed) observer.record("retain_end", { phase, outcome, inclusive_usage: difference(spent(this), before),
      accounting: "inclusive_only_not_added_to_leaf_debits" }); }
  });
  return [chargeSpy, reserveSpy, retainSpy];
}

function observeSourceReads(observer: PublicationObserver) {
  const prototype = SqliteFieldSourceRecordRepo.prototype;
  const current = prototype.findCurrent, byId = prototype.findById;
  return (["findCurrent", "findById"] as const).map(method => vi.spyOn(prototype, method)
    .mockImplementation(function (this: SqliteFieldSourceRecordRepo, workspaceId, requestedId) {
      let row: SourceRow | undefined, error: unknown;
      try { row = (method === "findCurrent" ? current : byId).call(this, workspaceId, requestedId); return row; }
      catch (caught) { error = caught; throw caught; }
      finally { observer.read(method, workspaceId, requestedId, row, error); }
    }));
}

function observePersistence(observer: PublicationObserver) {
  const eventPrototype = SqliteEventLogRepo.prototype, capsulePrototype = SqliteEvidenceCapsuleRepo.prototype;
  const transactional = eventPrototype.transactional, append = eventPrototype.append, create = capsulePrototype.createInCurrentTransaction;
  const transactionSpy = vi.spyOn(eventPrototype, "transactional").mockImplementation(function <T>(this: SqliteEventLogRepo, fn: () => T): T {
    observer.filename = this.getStorageConnectionIdentity().filename;
    observer.record("transaction_enter");
    try { const result = transactional.call(this, fn) as T; observer.record("transaction_return"); return result; }
    catch (error) { observer.record("transaction_throw", { error: failure(error) }); throw error; }
  });
  const appendSpy = vi.spyOn(eventPrototype, "append").mockImplementation(function (this: SqliteEventLogRepo, event) {
    observer.filename = this.getStorageConnectionIdentity().filename;
    observer.record("event_log_append_enter", { event_type: event.event_type, entity_id: event.entity_id });
    try {
      const result = append.call(this, event);
      observer.record("event_log_append_return", { returned_promise: result instanceof Promise,
        event_id: result instanceof Promise ? null : result.event_id });
      if (observer.active !== null && result instanceof Promise) observer.stop("attribution_unavailable", "async audit completion unobserved");
      return result;
    } catch (error) { observer.record("event_log_append_throw", { error: failure(error) }); throw error; }
  });
  const capsuleSpy = vi.spyOn(capsulePrototype, "createInCurrentTransaction").mockImplementation(function (this: SqliteEvidenceCapsuleRepo, ...args) {
    observer.record("capsule_create_enter", { object_id: args[0].object_id });
    try { const result = create.apply(this, args); observer.record("capsule_create_return", { object_id: result.object_id }); return result; }
    catch (error) { observer.record("capsule_create_throw", { error: failure(error) }); throw error; }
  });
  return [transactionSpy, appendSpy, capsuleSpy];
}

function publicationReport(row: Publication) {
  return { source_id: row.source_id, publication_index: row.publication_index, before: row.before,
    leaf_debits: row.leaf_debits, labels: [...row.labels].map(([phase, usage]) => ({ phase, ...usage })),
    usage_receipt: row.end?.usage ?? null, outcome: row.end?.outcome.status ?? "unavailable",
    result: row.end?.outcome.status === "published" ? row.end.outcome.result : null,
    error: row.end?.outcome.status === "failed" ? failure(row.end.outcome.error) : null };
}

const revision = process.env.ALAYA_SOURCE_PUBLICATION_COST_IMPLEMENTATION_REVISION;
// Opt in only for the bound observation; ordinary test runs must not consume another native publication attempt.
it.skipIf(revision === undefined)("attributes two frozen native publications to actual ledger debits and SQLite reads", async () => {
  const binding = executionBinding(revision);
  expect(binding.execution_kind).toBe("bound_experiment");
  const sources: AccessFixtureSource[] = INPUTS.map(input => ({ id: input.id, text: input.text, verbatim: true,
    recordedAt: input.at, publicationAt: input.at, authoredDraft: catalog => eventDraft(catalog, true) }));
  expect(INPUTS.map(input => Buffer.byteLength(input.text))).toEqual(INPUTS.map(input => input.bytes));
  const observer = new PublicationObserver();
  const spies = [...observeLedger(observer), ...observeSourceReads(observer), ...observePersistence(observer)];
  let setup: Awaited<ReturnType<typeof withAccessLibrary>> | null = null, nativeError: unknown;
  let helperReceipts: unknown = null, idleWorkerReady = false;
  try {
    setup = await withAccessLibrary(sources, async ({ publicationUsage }) => {
      idleWorkerReady = true;
      helperReceipts = [...publicationUsage].map(([source_id, usage]) => ({ source_id, usage }));
    }, { publicationBudget: BUDGET, onPublicationBoundary: event => observer.boundary(event),
      onSetupExhausted: async ({ publicationUsage }) => {
        helperReceipts = [...publicationUsage].map(([source_id, usage]) => ({ source_id, usage }));
      } });
  } catch (error) {
    nativeError = error;
    if (error instanceof AggregateError) observer.stop("attribution_unavailable", "aggregate helper failure requires attribution");
    else if (error !== observer.dispatchStop) observer.stop("publication_failed", failure(error).message ?? "native setup failed");
  } finally { for (const spy of spies.reverse()) spy.mockRestore(); }
  const total = observer.publications.reduce((sum, row) => { add(sum, row.leaf_debits); return sum; }, { work_units: 0, memory_bytes: 0 });
  if (observer.meter === undefined || !isDeepStrictEqual(total, spent(observer.meter))
    || observer.publications.some(row => row.end === null)) observer.stop("attribution_unavailable", "shared reconciliation or receipt unavailable");
  if (helperReceipts !== null && (!isDeepStrictEqual(helperReceipts, observer.publications.map(row => ({
    source_id: row.source_id, usage: [row.end?.usage] }))) || !isDeepStrictEqual(setup?.known_publication_subtotal, total))) {
    observer.stop("attribution_unavailable", "helper receipt map or subtotal does not reconcile");
  }
  if (observer.stops.length === 0 && (setup?.status !== "complete" || observer.publications.length !== INPUTS.length
    || helperReceipts === null || observer.manifest?.sources.length !== INPUTS.length
    || observer.manifest.publications.length !== INPUTS.length)) observer.stop("attribution_unavailable", "completion evidence unavailable");
  const report = { contract: "source-publication-cost-observation-v1", ...binding,
    status: nativeError instanceof AggregateError ? "attribution_unavailable" : observer.stops[0]?.status ?? "complete",
    stops: observer.stops, budget: BUDGET, diagnostic_limits: LIMITS,
    frozen_sources: INPUTS, publications: observer.publications.map(publicationReport),
    helper_setup: setup, helper_usage_receipts: helperReceipts, shared_usage: observer.meter === undefined ? null : spent(observer.meter),
    source_reads: [...observer.reads.values()], source_read_calls: observer.sourceReadCalls,
    returned_source_body_bytes: observer.sourceBodyBytes, events: observer.events, omitted_events: observer.omittedEvents,
    persistent_effects_before_cleanup: observer.manifest,
    persistence_snapshot_after_sequence: observer.manifestSequence,
    persistence_snapshot_completeness: setup !== null || nativeError === observer.dispatchStop
      ? "observed_at_settled_boundary" : "last_boundary_only_later_effects_unknown",
    admitted_source_ids_before_cleanup: observer.manifest?.sources.map(row => row.source_id) ?? null,
    diagnostic_manifest_reads: observer.manifestReads,
    helper_error: nativeError === undefined ? null : failure(nativeError), idle_worker_ready: idleWorkerReady,
    worker_requests: 0, unknown_costs: ["recorder allocation and time", "physical disk IO", "RSS", "unlabeled lifecycle intervals"],
    accounting: { logical_allocations: "cumulative_not_peak", native_bytes: "returned_source_body_utf8_copies",
      preparation: "native_label_unclassified", retain_usage: "inclusive_not_added", outside_publication_reads: "separate_from_publication",
      diagnostic_manifest_reads: "outside_publisher_ledger_and_repository_counters", worker_lifecycle: "outside_publication_observation" } };
  console.log(`SOURCE_PUBLICATION_COST ${JSON.stringify(report)}`);
  expect(report.status).toBe("complete");
}, 120_000);

it("retains native publication and end-observer failures while stopping and cleaning up the actual helper", async () => {
  const observerError = new Error("publication end observation failed"), boundaries: PublicationBoundary[] = [];
  const filenames = new Set<string>(), appendOriginal = SqliteEventLogRepo.prototype.append;
  const append = vi.spyOn(SqliteEventLogRepo.prototype, "append").mockImplementation(function (this: SqliteEventLogRepo, event) {
    filenames.add(this.getStorageConnectionIdentity().filename);
    return appendOriginal.call(this, event);
  });
  const body = vi.fn(async () => undefined), exhausted = vi.fn(async () => undefined);
  let nativeError: unknown, caught: unknown;
  try {
    await withAccessLibrary([
      { id: "failed-publication", text: "Alice uses X.", reading: "uses" },
      { id: "undispatched-publication", text: "Bob uses Y.", reading: "uses" }
    ], body, { publicationBudget: { work_units: 0, memory_bytes: 0 }, onSetupExhausted: exhausted,
      onPublicationBoundary: event => {
        boundaries.push(event);
        if (event.kind === "end") {
          if (event.outcome.status === "failed") nativeError = event.outcome.error;
          throw observerError;
        }
      } });
  } catch (error) { caught = error; }
  finally { append.mockRestore(); }
  expect(nativeError).toBeInstanceOf(SourceSemanticResourceExhausted);
  expect(caught).toBeInstanceOf(AggregateError);
  if (!(caught instanceof AggregateError)) throw new Error("paired failure must escape the helper");
  expect(caught.errors).toHaveLength(2);
  expect(caught.errors[0]).toBe(nativeError);
  expect(caught.errors[1]).toBe(observerError);
  expect(caught.cause).toBe(nativeError);
  expect(failure(caught)).toMatchObject({ name: "AggregateError",
    errors: [{ message: "source semantic publication input budget exhausted", phase: "publication input" },
      { message: observerError.message }], cause: { phase: "publication input" } });
  expect(boundaries.map(event => [event.kind, event.source_id])).toEqual([
    ["begin", "failed-publication"], ["end", "failed-publication"]
  ]);
  expect(body).not.toHaveBeenCalled();
  expect(exhausted).not.toHaveBeenCalled();
  expect(filenames.size).toBe(1);
  const filename = [...filenames][0]!;
  expect(existsSync(filename)).toBe(false);
  expect(existsSync(dirname(filename))).toBe(false);
});
