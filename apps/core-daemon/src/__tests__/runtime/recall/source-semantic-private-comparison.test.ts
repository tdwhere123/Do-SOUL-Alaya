import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); vi.restoreAllMocks(); });
afterAll(() => isolation.restore());
import { performance } from "node:perf_hooks";
import { attributeObservation } from "../../../../../bench-runner/src/runs/longmemeval-semantic/observation-attribution.js";
import { scoreConsumerMessageVisibility } from "../../../../../bench-runner/src/runs/longmemeval-semantic/message-visibility.js";
import { nativeSourceAccessPositions } from "../../../runtime/recall-read-worker/source-semantic-native-access.js";
import { acquireProfiledSourceIndex, fieldContractSha256, sourceSemanticLibraryRequestIdentity } from "@do-soul/alaya-core";
import { canonicalJson, packSourceSemanticAcquisition, packSourceSemanticQueryPreparation,
  unavailableSourceQueryPreparation, sourceSemanticAccessPhases, type SourceSemanticAccessProfile, type SourceSemanticRetainedNominationWitness } from "@do-soul/alaya-protocol";
import { SqliteSourceHintReader } from "@do-soul/alaya-storage";
import { capturePrivateSourceLibrary, admitPrivateSourceLibraryCapture } from "../../../../../bench-runner/src/runs/recall-measurement/private-library-capture.js";
import { admitDeliveredSources } from "../../../../../bench-runner/src/runs/recall-measurement/library-admission.js";
import { sourceLookupStores } from "../../../../../bench-runner/src/runs/snapshot/source-records/publish.js";
import { SourceSemanticReadBudget } from "../../../runtime/field/source-semantic-read-stores.js";
import { sourceSemanticAccessReceiptValue, bindAccessPoolIdentity, quoteAccessPoolIdentity } from "../../../runtime/recall-read-worker/source-semantic-access-receipts.js";
import { sourceSemanticRevision, readSemanticLease } from "../../../runtime/recall-read-worker/source-semantic-leases.js";
import { sourceSemanticLibrarySnapshotIdentity } from "../../../runtime/recall-read-worker/source-semantic-library-recall.js";
import { runSourceSemanticWorker } from "../../../runtime/recall-read-worker/source-semantic-reasoning.js";
import { parseWorkerOperationResult } from "../../../runtime/recall-read-worker/operation-schemas.js";
import type { RecallReadWorkerRuntime, SourceSemanticReadRuntime } from "../../../runtime/recall-read-worker/runtime.js";
import { createMcpMemoryToolHandler } from "../../../mcp-memory/tool/tool-handler.js";
import { bindSourceComparisonExecution, sourceComparisonForRuntime } from "../../../runtime/recall/source-comparison-execution.js";
import { createDeps } from "../../mcp-memory/tool/mcp-memory-tool-handler-fixture.js";
import { CLOCK, QUERY_BUDGET, SCOPES, WS, withIndexedSources } from "./source-semantic-index-acquisition.test-support.js";

const profile: SourceSemanticAccessProfile = { contract: "source-semantic-access-v3", result_version: "source-semantic-library-v7",
  protocol_version: 9, order_policy: "native-route-round-robin-v1", acquisition_policy: "source-index-grouped-round-robin.v1",
  channels: "dual", declared_allowance: { max_attempts: 64, max_roots: 18, max_vector_windows: 64 } };
const budget = { ...QUERY_BUDGET, work_units: 2_000_000, memory_bytes: 20_000_000 };
const request = { operation: "recall" as const, accepts_unreviewed_conditional_results: true as const,
  original_query: "needle", semantic_correspondences: [], authorized_scopes: SCOPES, budget, output_byte_limit: 176340 };
const sources = Array.from({ length: 18 }, (_, index) => ({ id: `source-${String(index).padStart(2, "0")}`,
  text: `needle ${index}`, vector: [1, 0, 0] }));

it("walks real captured SQLite pages beyond sixteen roots, paying duplicates within one attempt/window envelope", async () => {
  await withIndexedSources(sources, async fixture => {
    const prepared = await fixture.prepareQuery({ navigation: "needle", signal: new AbortController().signal, remainingMs: () => 60000 });
    const acquire = (candidate: SourceSemanticAccessProfile) => fixture.database.connection.transaction(() => acquireProfiledSourceIndex({
      repository: fixture.repository, sha256: fieldContractSha256, workspace: WS,
      original: { navigation: "needle", vector: prepared.vector }, profile: candidate, budget, admitScope: () => "admitted"
    }))();
    const small = acquire({ ...profile, declared_allowance: { ...profile.declared_allowance, max_roots: 16 } });
    const large = acquire(profile);
    expect(small.nominations).toHaveLength(16);
    expect(large.nominations).toHaveLength(18);
    expect(large.witness).toHaveLength(36);
    expect(large.phase.result).toMatchObject({ counts: { attempts: 36, retained_occurrences: 36,
      distinct_roots: 18, duplicate_occurrences: 18 }, vector: { inspected_windows: 18 },
    prefix_coverage: { kind: "retained_occurrence_prefix", omitted_occurrences: 20 } });
    expect(large.phase.result!.lanes.reduce((sum, lane) => sum + lane.consumed_occurrences, 0)).toBe(36);
    const fixed = { ...profile, acquisition_policy: "source-index-interleaved-prefix.v1" as const,
      declared_allowance: { ...profile.declared_allowance, max_roots: 16 } };
    expect(acquire({ ...fixed, order_policy: "query-conditioned-v1" }).nominations).toEqual(acquire(fixed).nominations);
  });
});

it("shares handler admission and synchronously captured context while keeping private fields out of public execute", async () => {
  await withIndexedSources(sources.slice(0, 2), async fixture => {
    const client = await fixture.openClient(), admission = vi.fn(async () => { await Promise.resolve(); });
    const handler = createMcpMemoryToolHandler({ ...createDeps(), now: () => CLOCK,
      zeroDayToolAccess: { enforceToolAccess: admission }, sourceSemanticsPort: client.sourceSemanticsPort });
    const runtime = { services: { mcpMemoryToolHandler: handler } };
    bindSourceComparisonExecution(runtime, handler, client.sourceSemanticsPort!);
    let active = { workspaceId: WS, runId: "run-real", sessionId: "enclosed-session", agentTarget: "bench-runner" };
    const execute = sourceComparisonForRuntime(runtime, () => active);
    await expect(client.sourceSemanticsPort!.execute({ workspace_id: WS, as_of: CLOCK,
      authorized_scopes: SCOPES, request: { ...request, kind: "recall" }, comparison: { profile } } as never)).rejects.toThrow();
    await expect(execute({ request })).rejects.toThrow(/explicit profile/);
    await expect(execute({ request, profile: null as never })).rejects.toThrow();
    expect(fixture.prepareQuery).not.toHaveBeenCalled();
    const pending = execute({ request, profile });
    active = { ...active, workspaceId: "different-workspace", runId: "changed-run" };
    const result = await pending;
    expect(admission).toHaveBeenLastCalledWith(WS, "soul.interpretation");
    expect(result.operation).toBe("recall");
    if (result.operation !== "recall") throw new Error("expected library delivery");
    expect(result.index.result_version).toBe("source-semantic-library-v7");
    expect(result.protocol_version).toBe(9);
    expect(result.discovery.access.profile).toEqual(profile);
    expect(result.index.entries).toHaveLength(2);
    expect(result.request_identity).toBe(sourceSemanticLibraryRequestIdentity({ workspace_id: WS, as_of: CLOCK,
      authorized_scopes: ["project"], original_query: request.original_query, query_semantics_status: { status: "unavailable", reason: "absent" },
      semantic_correspondences: [], budget, output_byte_limit: request.output_byte_limit, candidate_profile: profile }));
  });
});

it("binds preparation, inherited/equal profiles and frozen continuations; conflicts and cross-family reuse fail before preparation", async () => {
  await withIndexedSources(sources, async fixture => {
    const client = await fixture.openClient();
    const handler = createMcpMemoryToolHandler({ ...createDeps(), now: () => CLOCK, sourceSemanticsPort: client.sourceSemanticsPort });
    const runtime = {};
    bindSourceComparisonExecution(runtime, handler, client.sourceSemanticsPort!);
    const execute = sourceComparisonForRuntime(runtime, () => ({ workspaceId: WS, runId: "run", sessionId: "session", agentTarget: "bench-runner" }));
    const prepared = await execute({ request: { operation: "prepare_query", original_query: "needle", authorized_scopes: SCOPES, budget }, profile });
    expect(prepared.operation).toBe("prepare_query");
    if (prepared.operation !== "prepare_query" || prepared.query_handle === undefined) throw new Error("private preparation unavailable");
    expect(prepared.access?.contract).toBe("source-semantic-access-v3");
    expect(sourceSemanticAccessPhases(prepared.access!).acquisition.result).toMatchObject({ counts: { distinct_roots: 18 } });
    const bound = { ...request, query_handle: prepared.query_handle };
    const before = fixture.prepareQuery.mock.calls.length;
    await expect(execute({ request: bound, profile: { ...profile, channels: "lexical" } })).rejects.toThrow(/profile conflicts/);
    await expect(execute({ request: { ...bound, access_policy: "query-conditioned-v1" }, profile })).rejects.toThrow(/access_policy/);
    const inherited = await execute({ request: bound });
    const equal = await execute({ request: bound, profile: { ...profile } });
    if (inherited.operation !== "recall" || equal.operation !== "recall") throw new Error("expected recall");
    expect(equal.request_identity).toBe(inherited.request_identity);
    expect(equal.discovery.access.pool_id).toBe(inherited.discovery.access.pool_id);
    expect(inherited.execution).toBe("native_reasoning_only");
    expect(inherited.work.index_work).toBe(0);
    expect(inherited.index.continuation).not.toBeNull();
    const continued = await execute({ request: { ...bound, continuation: inherited.index.continuation } });
    expect(continued.operation).toBe("recall");
    if (continued.operation !== "recall") throw new Error("expected continuation");
    expect(continued.execution).toBe("native_reasoning_only");
    expect(continued.work.index_work).toBe(0);
    expect(fixture.prepareQuery.mock.calls).toHaveLength(before);
    const worker = { kind: "recall" as const, accepts_unreviewed_conditional_results: true as const, query_handle: prepared.query_handle,
      budget, output_byte_limit: 176340 };
    await expect(client.sourceSemanticsPort!.execute({ workspace_id: WS, as_of: CLOCK, authorized_scopes: SCOPES, request: worker })).rejects.toThrow(/private comparison/);
  });
});

it("quotes and binds the same full witness preimage; occurrence seventeen changes pool and library snapshot identities", async () => {
  await withIndexedSources(sources, async fixture => {
    const prepared = await fixture.prepareQuery({ navigation: "needle", signal: new AbortController().signal, remainingMs: () => 60000 });
    const produced = fixture.database.connection.transaction(() => acquireProfiledSourceIndex({ repository: fixture.repository,
      sha256: fieldContractSha256, workspace: WS, original: { navigation: "needle", vector: prepared.vector },
      profile, budget, admitScope: () => "admitted" }))();
    expect(Object.isFrozen(produced.witness)).toBe(true);
    const runtime = { database: fixture.database } as SourceSemanticReadRuntime;
    const packing = new SourceSemanticReadBudget(budget);
    const receipt = sourceSemanticAccessReceiptValue(packing, "query-conditioned-v1", `sha256:${"a".repeat(64)}`,
      [], [], false, false, [], undefined, {
        preparation: packSourceSemanticQueryPreparation(unavailableSourceQueryPreparation("test_not_requested", "not_requested"), packing),
        acquisition: packSourceSemanticAcquisition(produced.phase, packing), observation: null
      }, profile);
    const altered = produced.witness.map((row, index) => index !== 16 ? row : { ...row, route: row.route.kind === "vector"
      ? { ...row.route, cosine: row.route.cosine / 2 } : { ...row.route, bm25: row.route.bm25 - 1 } });
    expect(altered.slice(0, 16)).toEqual(produced.witness.slice(0, 16));
    const bind = (retainedWitness: typeof produced.witness) => {
      const quote = quoteAccessPoolIdentity(runtime, WS, ["project"], receipt, new SourceSemanticReadBudget(budget), { retainedWitness });
      const actual = new SourceSemanticReadBudget({ work_units: quote.work_units, memory_bytes: quote.memory_bytes });
      const result = bindAccessPoolIdentity(runtime, WS, ["project"], receipt, actual, quote.prepared, retainedWitness);
      expect(actual.remaining()).toEqual({ work_units: 0, memory_bytes: 0 });
      const { phases: _phases, ...fields } = receipt;
      expect(result.pool_id).toBe(`sha256:${fieldContractSha256(canonicalJson({
        receipt: { ...fields, ...sourceSemanticAccessPhases(receipt) }, workspace: WS, authorized: ["project"],
        revision: sourceSemanticRevision(runtime), retained_witness: retainedWitness
      }))}`);
      return result.pool_id;
    };
    const original = bind(produced.witness), changed = bind(altered);
    expect(changed).not.toBe(original);
    const snapshot = (access_pool: string) => sourceSemanticLibrarySnapshotIdentity({ workspace: WS, as_of: CLOCK,
      scopes: ["project"], revision: sourceSemanticRevision(runtime), requestIdentity: "same-request", sources: [], access_pool,
      semantic_correspondences: [] });
    expect(snapshot(changed)).not.toBe(snapshot(original));
    expect(() => bindAccessPoolIdentity(runtime, WS, ["project"], receipt, new SourceSemanticReadBudget(budget))).toThrow(/full producer witness/);
  });
});

it("captures private emitted bytes through the shared exposure owner and readmits a versioned two-page artifact before labels", async () => {
  await withIndexedSources(sources, async fixture => {
    const client = await fixture.openClient();
    const handler = createMcpMemoryToolHandler({ ...createDeps(), now: () => CLOCK, sourceSemanticsPort: client.sourceSemanticsPort });
    const runtime = {};
    bindSourceComparisonExecution(runtime, handler, client.sourceSemanticsPort!);
    const compareSourceSemantics = sourceComparisonForRuntime(runtime, () => ({ workspaceId: WS, runId: "actual-run",
      sessionId: "actual-enclosed-session", agentTarget: "bench-runner" }));
    const capture = await capturePrivateSourceLibrary({ daemon: { compareSourceSemantics }, request, profile, maxPages: 2 });
    expect(capture.pages).toHaveLength(2);
    expect(capture.pages.map(page => page.entry)).toEqual(["private_source_comparison", "private_source_comparison"]);
    expect(capture.pages[0]!.context).toEqual({ workspace_id: WS, run_id: "actual-run", session_id: "actual-enclosed-session", agent_target: "bench-runner" });
    const options = { workspace_id: WS, run_id: "actual-run", as_of: CLOCK, request, profile,
      verifySources: (response: Extract<import("@do-soul/alaya-protocol").SourceSemanticComparisonResponse, { operation: "recall" }>) =>
        admitDeliveredSources({ workspace_id: WS }, response, sourceLookupStores(fixture.database),
          new SqliteSourceHintReader(fixture.database.connection), ["project"], []) };
    const roundTrip = JSON.parse(JSON.stringify(capture));
    const admitted = admitPrivateSourceLibraryCapture(roundTrip, options);
    expect(admitted.pages.map(page => page.records.length)).toEqual([5, 5]);
    expect(fixture.prepareQuery).toHaveBeenCalledTimes(1);
    const mixed = structuredClone(capture);
    if (mixed.pages[0]!.response.operation !== "recall") throw new Error("expected recall");
    Reflect.set(mixed.pages[0]!.response.index, "result_version", "source-semantic-library-v6");
    expect(() => admitPrivateSourceLibraryCapture(mixed, options)).toThrow();
    expect(() => admitPrivateSourceLibraryCapture(roundTrip, { ...options, run_id: "fabricated-run" })).toThrow(/bound context/);
    expect(() => admitPrivateSourceLibraryCapture(roundTrip, { ...options, verifySources: () => [] })).toThrow(/sealed current source/);
  });
});

it("shares hints and original routes, denies unauthorized roots, and reports real budget refusal without widening allowances", async () => {
  await withIndexedSources([{ id: "allowed", text: "needle one", vector: [1, 0, 0] },
    { id: "denied", text: "needle two", vector: [1, 0, 0], scope: "global_core" }], async fixture => {
    const prepared = await fixture.prepareQuery({ navigation: "needle", supplemental_navigation: "needle extra",
      signal: new AbortController().signal, remainingMs: () => 60000 });
    const input = { repository: fixture.repository, sha256: fieldContractSha256, workspace: WS,
      original: { navigation: "needle", vector: prepared.vector }, hint: { navigation: "needle extra", vector: prepared.supplemental!.vector },
      profile, budget, admitScope: (scope: string | null) => scope === "project" ? "admitted" as const : "denied" as const };
    const result = fixture.database.connection.transaction(() => acquireProfiledSourceIndex(input))();
    expect(result.nominations.map(row => row.source_id)).toEqual(["allowed"]);
    expect(result.phase.result!.counts.denied).toBeGreaterThan(0);
    expect(result.phase.result!.counts.duplicate_occurrences).toBeGreaterThan(0);
    expect(result.phase.result!.lanes.some(lane => lane.view === "hint" && lane.consumed_occurrences > 0)).toBe(true);
    expect(result.phase.result!.counts.attempts).toBeLessThanOrEqual(profile.declared_allowance.max_attempts);
    expect(result.phase.result!.vector.inspected_windows).toBeLessThanOrEqual(profile.declared_allowance.max_vector_windows);
    expect(() => fixture.database.connection.transaction(() => acquireProfiledSourceIndex({ ...input,
      budget: { work_units: 1, memory_bytes: 2000 } }))()).toThrow();
    vi.spyOn(fixture.repository, "readLexicalCandidates").mockImplementation(() =>
      fixture.database.connection.prepare("SELECT * FROM missing_source_table").get() as never);
    const failed = fixture.database.connection.transaction(() => acquireProfiledSourceIndex(input))();
    expect(failed.phase).toMatchObject({ status: "failed", accounting: "partial", result: { completion: "partial",
      counts: { attempts: 0, resource_refused_before_start: 0, resource_refused_after_start: 0 } } });
    expect(failed.phase.result!.resource_refusals).toHaveLength(2);
    expect(failed.phase.result!.resource_refusals.every(row => row.phase === "acquisition_failed_unknown_additional_cost")).toBe(true);
  });
});

it("rejects public handles, expired private leases and changed SQLite snapshots before any replacement preparation", async () => {
  await withIndexedSources(sources.slice(0, 2), async fixture => {
    const client = await fixture.openClient();
    let now = CLOCK;
    const handler = createMcpMemoryToolHandler({ ...createDeps(), now: () => now, sourceSemanticInterpretationClock: CLOCK,
      sourceSemanticsPort: client.sourceSemanticsPort });
    const runtime = {};
    bindSourceComparisonExecution(runtime, handler, client.sourceSemanticsPort!);
    const execute = sourceComparisonForRuntime(runtime, () => ({ workspaceId: WS, runId: "run", sessionId: "session", agentTarget: "bench-runner" }));
    const publicQuery = await client.sourceSemanticsPort!.execute({ workspace_id: WS, as_of: CLOCK, authorized_scopes: SCOPES,
      request: { kind: "prepare_query", original_query: "needle", budget } });
    if (publicQuery.kind !== "prepare_query" || publicQuery.query_handle === undefined) throw new Error("public preparation missing");
    const before = fixture.prepareQuery.mock.calls.length;
    await expect(execute({ request: { ...request, query_handle: publicQuery.query_handle }, profile })).rejects.toThrow(/public handle/);
    await expect(execute({ request, profile: { ...profile, acquisition_policy: "source-index-interleaved-prefix.v1" } })).rejects.toThrow(/policy ceiling/);
    expect(fixture.prepareQuery.mock.calls).toHaveLength(before);
    const make = () => execute({ request: { operation: "prepare_query", original_query: "needle", authorized_scopes: SCOPES, budget }, profile });
    const prepared = await make();
    if (prepared.operation !== "prepare_query" || prepared.query_handle === undefined) throw new Error("private preparation missing");
    const afterPrepare = fixture.prepareQuery.mock.calls.length;
    now = "2026-09-18T00:20:00.000Z";
    await expect(execute({ request: { ...request, query_handle: prepared.query_handle } })).rejects.toThrow(/expired/);
    expect(fixture.prepareQuery.mock.calls).toHaveLength(afterPrepare);
    now = CLOCK;
    const stale = await make();
    if (stale.operation !== "prepare_query" || stale.query_handle === undefined) throw new Error("private preparation missing");
    const beforeWrite = fixture.prepareQuery.mock.calls.length;
    await fixture.admit({ id: "new-source", text: "native admission changes snapshot" });
    await expect(execute({ request: { ...request, query_handle: stale.query_handle } })).rejects.toThrow(/snapshot is no longer current/);
    expect(fixture.prepareQuery.mock.calls).toHaveLength(beforeWrite);
  });
});

it("keeps candidate observation off/on/overflow noninterfering and attributes full retained occurrences separately from malformed detail", async () => {
  await withIndexedSources(sources, async fixture => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    const open = async () => {
      const client = await fixture.openClient();
      const handler = createMcpMemoryToolHandler({ ...createDeps(), now: () => CLOCK, sourceSemanticsPort: client.sourceSemanticsPort });
      const runtime = {};
      bindSourceComparisonExecution(runtime, handler, client.sourceSemanticsPort!);
      return { client, execute: sourceComparisonForRuntime(runtime, () => ({ workspaceId: WS, runId: "run", sessionId: "observer-session", agentTarget: "bench-runner" })) };
    };
    const input = { request: { operation: "prepare_query", original_query: "needle", authorized_scopes: SCOPES, budget }, profile };
    const off = await open(), offResult = await off.execute(input);
    const on = await open(), observed = await on.client.observeSourceSemantics({ max_events: 2048, max_bytes: 524288 }, () => on.execute(input));
    const overflow = await open(), bounded = await overflow.client.observeSourceSemantics({ max_events: 0, max_bytes: 0 }, () => overflow.execute(input));
    if (observed.outcome.status === "failure") throw observed.outcome.error;
    if (bounded.outcome.status === "failure") throw bounded.outcome.error;
    const normalize = (result: typeof offResult) => {
      if (result.operation !== "prepare_query") throw new Error("expected preparation");
      const { query_handle: _query, continuation_handle: _page, work, ...value } = result;
      return { ...value, work: { ...work, rss_bytes: 0 } };
    };
    expect(normalize(observed.outcome.value)).toEqual(normalize(offResult));
    expect(normalize(bounded.outcome.value)).toEqual(normalize(offResult));
    expect(bounded.status).toBe("available");
    expect(bounded.observations[0]?.status).toBe("overflow");
    const frame = observed.observations[0]!;
    const event = frame.events.find(row => row.kind === "source_index_routes")!;
    const evidence = event.data as { retained_occurrences: SourceSemanticRetainedNominationWitness };
    expect(evidence.retained_occurrences).toHaveLength(36);
    const occurrence = evidence.retained_occurrences[16]!;
    const target = occurrence.source.target;
    const gold = { workspace_id: WS, root_kind: "source_record" as const, root_id: target.root_id,
      source_version: target.source_version, content_digest: target.content_digest };
    const answer = { unit: "published_body_utf8_bytes" as const, annotated_turns: 1, complete: true,
      spans: [{ session_index: 0, message_index: 0, source_id: occurrence.source.source_id, target: gold, start: 0, end: 1 }] };
    const visibility = scoreConsumerMessageVisibility({ gold: answer, pages: [] });
    const call = { kind: "prepare_query" as const, request_id: frame.request_id, session_id: frame.facts!.binding!.session_id, query_key: "synthetic",
      snapshot_id: null, workspace_id: WS, as_of: CLOCK };
    const attribute = (observation: typeof frame) => attributeObservation({ question_id: "synthetic", k: 5, call,
      frames: [{ call, observation }], frozen_index: null, admitted_roots: new Map(), admitted_roots_complete: false, answer_gold: answer, visibility });
    const route = (value: ReturnType<typeof attribute>) => value.messages[0]!.routes.find(row => row.route === `index:${occurrence.view}:${occurrence.route.kind}`)!;
    expect(route(attribute(frame)).native?.occurrence_evidence).toBe("full_retained");
    expect(route(attribute(frame)).native?.retained_occurrences?.length).toBeGreaterThan(0);
    expect(route(attribute(frame)).eligibility).toBe("unknown");
    const malformed = structuredClone(frame), bad = malformed.events.find(row => row.kind === "source_index_routes")!;
    const detail = bad.data as { retained_occurrences: { route: { native_rank: number } }[] };
    detail.retained_occurrences[16]!.route.native_rank = -1;
    expect(route(attribute(malformed)).diagnostic_issues.some(issue => issue.field === "retained_occurrences")).toBe(true);
    expect(route(attribute(malformed)).native?.occurrence_evidence).toBe("displayed_prefix");
    const actualRecords = await fixture.admit({ id: "catalog-only", text: "no captured position" });
    expect(() => nativeSourceAccessPositions([actualRecords], [], undefined, true, new SourceSemanticReadBudget(budget))).toThrow(/non_total/);
  });
});

it("keeps legacy library lease material free of private fields while retaining the complete candidate witness", async () => {
  await withIndexedSources(sources, async fixture => {
    const runtime = { database: fixture.database } as RecallReadWorkerRuntime;
    const { operation, authorized_scopes, ...native } = request;
    const payload = { workspace_id: WS, as_of: CLOCK, authorized_scopes,
      request: { kind: operation, ...native } };
    const ordinary = runSourceSemanticWorker(runtime, payload);
    if (ordinary.kind !== "recall" || ordinary.index.continuation === null) throw new Error("public continuation missing");
    const lease = readSemanticLease(runtime, payload, ordinary.index.continuation.continuation_id, ["project"], "library");
    expect(Object.hasOwn(lease, "profile")).toBe(false);
    expect(Object.hasOwn(lease.library_plan!, "profile")).toBe(false);
    expect(Object.hasOwn(lease.library_plan!, "retainedWitness")).toBe(false);
    const candidatePayload = { ...payload, comparison: { profile } };
    const candidate = runSourceSemanticWorker(runtime, candidatePayload);
    if (candidate.kind !== "recall" || candidate.index.continuation === null) throw new Error("candidate continuation missing");
    const retained = readSemanticLease(runtime, candidatePayload, candidate.index.continuation.continuation_id, ["project"], "library");
    expect(retained.profile).toEqual(profile);
    expect(retained.library_plan?.retainedWitness).toHaveLength(18);
    expect(retained.library_plan?.page_access[0]?.phases[2][0]).toBe(2);
  });
});

it("admits a candidate result once without cloning its nested data through the public family", async () => {
  await withIndexedSources(sources, async fixture => {
    const runtime = { database: fixture.database } as RecallReadWorkerRuntime;
    const { operation, authorized_scopes, ...native } = request;
    const candidate = runSourceSemanticWorker(runtime, { workspace_id: WS, as_of: CLOCK, authorized_scopes,
      comparison: { profile }, request: { kind: operation, ...native } });
    let coverageReads = 0;
    const observed = { ...candidate, get coverage() { coverageReads += 1; return candidate.coverage; } };
    const admitted = parseWorkerOperationResult("conditionalField.sourceSemantics", observed);
    expect(admitted).toMatchObject({ kind: "recall", protocol_version: 9 });
    expect(coverageReads).toBe(1);
  });
});
