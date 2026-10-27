import { afterAll, afterEach, expect, it, vi } from "vitest";
import { startBenchDaemon } from "../../../../../bench-runner/src/harness/daemon.js";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); vi.restoreAllMocks(); });
afterAll(() => isolation.restore());
import { SOURCE_SEMANTIC_FIELD_LIBRARY_PROTOCOL_VERSION, SoulInterpretationRequestSchema,
  type SourceEvidenceTarget } from "@do-soul/alaya-protocol";
import { fieldContractSha256, RecallService, capableRecallConsumerDeclaration,
  runConditionalFieldRecallWithReceipt, captureIndexPreviews, captureIndexSourceMetadata,
  encodeIndexResults, snapshotIdFromPin, type ConditionalFieldRecallRequest } from "@do-soul/alaya-core";
import { SoulMemorySearchResponseSchema } from "@do-soul/alaya-protocol";
import { createDependencies } from "../../../../../../packages/core/src/__tests__/recall/recall-service-test-fixtures.js";
import { createDeps } from "../../mcp-memory/tool/mcp-memory-tool-handler-fixture.js";
import { createMcpMemoryToolHandler } from "../../../mcp-memory/tool/tool-handler.js";
import { SqliteEvidenceCapsuleRepo, SqliteFieldSourceRecordRepo, SqliteSourceRootRecallReader } from "@do-soul/alaya-storage";
import { createConditionalFieldObserverReaders } from "../../../runtime/recall-read-worker/observer-operations.js";
import { CLOCK, QUERY_BUDGET, SCOPES, WS, SIMULATED_CONFIGURATION, publicMcp, withIndexedSources } from "./source-semantic-index-acquisition.test-support.js";

const firstLine = `needle ${"é".repeat(350)}\n`;
const text = `${firstLine}${"tail ".repeat(600)}\n`;
const lineEnd = Buffer.byteLength(firstLine);
const sources = ["first", "second"].map(id => ({ id, text, vector: [1, 0, 0], spans: [
  { start_offset: 0, end_offset: lineEnd, purpose: "line" as const },
  { start_offset: lineEnd, end_offset: Buffer.byteLength(text), purpose: "line" as const }
] }));

it("defers a partial recorded line to the next membership page without skipping it or changing replay", async () => {
  const message = `needle ${"é".repeat(600)}\n`;
  const body = `${message}${"tail ".repeat(600)}`;
  const roots = ["first-line", "next-line"].map(id => ({ id, text: body, vector: [1, 0, 0], spans: [
    { start_offset: 0, end_offset: Buffer.byteLength(message), purpose: "line" as const },
    { start_offset: Buffer.byteLength(message), end_offset: Buffer.byteLength(body), purpose: "line" as const }
  ] }));
  await withIndexedSources(roots, async fixture => {
    const client = await fixture.openClient();
    const service = new RecallService({ ...createDependencies().dependencies, now: () => CLOCK,
      readSnapshot: client.readSnapshot, conditionalFieldPort: client.conditionalFieldPort,
      activeConstraintsPort: client.activeConstraintsPort });
    const calls = vi.spyOn(service, "recall");
    const handler = createMcpMemoryToolHandler({ ...createDeps(), now: () => CLOCK, recallService: service });
    const request = { ...capableRecallConsumerDeclaration(), query: "needle", max_results: 2,
      scope_class: "project", dimension: null, domain_tags: null, result_kind_view: "source_only" };
    const call = async (args: object) => {
      const response = await handler.call({ toolName: "soul.recall", arguments: args,
        context: { workspaceId: WS, runId: "run", sessionId: "complete-line", agentTarget: "codex" } });
      if (!response.ok) throw new Error(JSON.stringify(response.error));
      return SoulMemorySearchResponseSchema.parse(response.output);
    };
    const first = await call(request);
    expect(first.index?.entries).toHaveLength(1);
    expect(first.results).toHaveLength(1);
    expect(first.results[0]!.content_preview).toBe(message);
    expect(first.index?.continuation).toBeTruthy();
    const continued = { ...request, continuation: first.index!.continuation };
    const next = await call(continued), replay = await call(continued);
    expect(next.index?.entries).toHaveLength(1);
    expect(next.results[0]!.content_preview).toBe(message);
    expect(next.results[0]!.target).not.toEqual(first.results[0]!.target);
    expect(next.results[0]!.target).toMatchObject({ span: { content_start: 0,
      content_end: Buffer.byteLength(message), content_complete: false } });
    expect(replay.results).toEqual(next.results);
    expect(replay.index).toEqual({ ...next.index, page_purpose: "retry" });
    const executed = await calls.mock.results[0]!.value;
    expect(executed.execution_receipt?.actual?.phases.index.budget_work).toBeGreaterThan(0);
    expect(executed.execution_receipt?.actual?.phases.payload.native_bytes).toBeGreaterThan(0);
  });
});

it("delivers a later vector hit from the root start through the built worker and MCP, preserving navigation and explicit continuation", async () => {
  const prefix = `${"é".repeat(127)}\n\n`, body = `${prefix}HIT ${"tail ".repeat(600)}`;
  expect(Buffer.byteLength(prefix)).toBe(256);
  const roots = ["vector-first", "vector-second"].map(id => ({ id, text: body,
    vector: (window: string) => window.startsWith("HIT ") ? [1, 0, 0] : [0, 1, 0],
    spans: [{ start_offset: 0, end_offset: 256, purpose: "line" as const },
      { start_offset: 256, end_offset: Buffer.byteLength(body), purpose: "line" as const }] }));
  await withIndexedSources(roots, async fixture => {
    const client = await fixture.openClient();
    const service = new RecallService({ ...createDependencies().dependencies, now: () => CLOCK,
      readSnapshot: client.readSnapshot, conditionalFieldPort: client.conditionalFieldPort,
      activeConstraintsPort: client.activeConstraintsPort });
    const handler = createMcpMemoryToolHandler({ ...createDeps(), now: () => CLOCK, recallService: service });
    const request = { ...capableRecallConsumerDeclaration(), query: "needle", max_results: 1,
      scope_class: "project", dimension: null, domain_tags: null, result_kind_view: "source_only" };
    const call = async (args: object) => {
      const response = await handler.call({ toolName: "soul.recall", arguments: args,
        context: { workspaceId: WS, runId: "run", sessionId: "vector-root", agentTarget: "codex" } });
      if (!response.ok) throw new Error(JSON.stringify(response.error));
      return SoulMemorySearchResponseSchema.parse(response.output);
    };
    const first = await call(request);
    expect(first.index?.result_version).toBe("ordinary-native-field.v5");
    expect(first.index?.entries[0]?.navigation).toMatchObject({ operator: "source_vector",
      location: { start_byte: 256, end_byte: 384 } });
    expect(first.results[0]?.content_preview).toBe(prefix);
    expect(first.results[0]?.target).toMatchObject({ span: { content_start: 0, content_end: 256, content_complete: false } });
    expect(first.index?.continuation).not.toBeNull();
    const continuation = { ...request, continuation: first.index?.continuation };
    const next = await call(continuation), replay = await call(continuation);
    expect(next.results[0]?.content_preview).toBe(prefix);
    expect(replay.results).toEqual(next.results);
    expect(next.results[0]?.target).not.toEqual(first.results[0]?.target);
    const target = next.results[0]!.target;
    const expansion = { ...request, continuation: next.index?.continuation,
      payload_continuation: { schema_version: 1, purpose: "payload_expansion", target, start_offset: 256, byte_budget: 64 } };
    const expanded = await call(expansion), repeated = await call(expansion);
    expect(expanded.results[0]?.content_preview).toBe(Buffer.from(body).subarray(256, 320).toString("utf8"));
    expect(expanded.results[0]?.target).toMatchObject({ span: { content_start: 256, content_end: 320, content_complete: false } });
    expect(repeated.results).toEqual(expanded.results);
    const obsolete = await call({ ...continuation,
      continuation: { ...first.index!.continuation, result_version: "ordinary-native-field.v3" } });
    expect(obsolete).toMatchObject({ results: [], index: { continuation: null,
      completeness: { logical_index: "invalidated" } } });
    // The same native hit in the library uses the new identity; explicit semantic
    // proof ranges are covered separately by the library computation tests.
    const library = await publicMcp(client)({ operation: "recall", accepts_unreviewed_conditional_results: true,
      original_query: "needle", semantic_correspondences: [], authorized_scopes: SCOPES,
      budget: { ...QUERY_BUDGET, page_budget: 1 }, output_byte_limit: 100_000 });
    expect(library).toMatchObject({ protocol_version: 12, results: [{ content_preview: prefix }] });
  }, { ...SIMULATED_CONFIGURATION, profile: { ...SIMULATED_CONFIGURATION.profile, window_bytes: 128 } });
});

it("delivers recorded lines through SQLite, built worker and MCP and replays the next page exactly", async () => {
  await withIndexedSources(sources, async fixture => {
    const call = publicMcp(await fixture.openClient());
    const request = { operation: "recall", accepts_unreviewed_conditional_results: true,
      original_query: "needle", semantic_correspondences: [], authorized_scopes: SCOPES,
      budget: { ...QUERY_BUDGET, page_budget: 1 }, output_byte_limit: 100_000 };
    const first = await call(request);
    if (first.operation !== "recall" || first.protocol_version !== SOURCE_SEMANTIC_FIELD_LIBRARY_PROTOCOL_VERSION) {
      throw new Error("current field delivery required");
    }
    expect(first.index.result_version).toBe("ordinary-native-field.v5");
    expect(first.results).toHaveLength(1);
    expect(first.results[0]?.content_preview).toBe(firstLine);
    expect(first.results[0]?.target).toMatchObject({ span: { content_start: 0, content_end: lineEnd, content_complete: false } });
    expect(first.index.entries[0]?.target).toEqual(first.results[0]?.target);
    expect(first.index.continuation).not.toBeNull();
    const continuedRequest = { ...request, continuation: first.index.continuation };
    const next = await call(continuedRequest), replay = await call(continuedRequest);
    if (next.operation !== "recall" || next.protocol_version !== SOURCE_SEMANTIC_FIELD_LIBRARY_PROTOCOL_VERSION
      || replay.operation !== "recall" || replay.protocol_version !== SOURCE_SEMANTIC_FIELD_LIBRARY_PROTOCOL_VERSION) {
      throw new Error("current continued field delivery required");
    }
    expect(next.results[0]?.content_preview).toBe(firstLine);
    expect(next.results[0]?.target).not.toEqual(first.results[0]?.target);
    expect(replay.index).toEqual({ ...next.index, page_purpose: "retry" });
    expect(replay.results).toEqual(next.results);
    expect(SoulInterpretationRequestSchema.safeParse({ ...request,
      continuation: { ...first.index.continuation, result_version: "ordinary-native-field.v1" } }).success).toBe(false);
  });
});

it("resumes ordinary MCP payload at its aligned end without a gap and rejects a stale version", async () => {
  await withIndexedSources(sources, async fixture => {
    const client = await fixture.openClient();
    const service = new RecallService({ ...createDependencies().dependencies, now: () => CLOCK,
      readSnapshot: client.readSnapshot, conditionalFieldPort: client.conditionalFieldPort,
      activeConstraintsPort: client.activeConstraintsPort });
    const calls = vi.spyOn(service, "recall");
    const handler = createMcpMemoryToolHandler({ ...createDeps(), now: () => CLOCK, recallService: service });
    const context = { workspaceId: WS, runId: "run", sessionId: "boundary-session", agentTarget: "codex" };
    const request = { ...capableRecallConsumerDeclaration(), query: "needle", max_results: 1,
      scope_class: "project", dimension: null, domain_tags: null, result_kind_view: "source_only" };
    const call = async (args: object) => {
      const response = await handler.call({ toolName: "soul.recall", arguments: args, context });
      if (!response.ok) throw new Error(JSON.stringify(response.error));
      return SoulMemorySearchResponseSchema.parse(response.output);
    };
    const first = await call(request);
    const target = first.results[0]?.target;
    expect(first.results[0]?.content_preview).toBe(firstLine);
    if (target?.kind !== "source_evidence" || target.span === undefined) throw new Error("delivered source required");
    const expansion = { ...request, continuation: first.index?.continuation,
      payload_continuation: { schema_version: 1, purpose: "payload_expansion", target,
        start_offset: target.span.content_end, byte_budget: 400 } };
    const expanded = await call(expansion), replay = await call(expansion);
    expect(expanded.results[0]?.content_preview).toBe("tail ".repeat(80));
    expect(expanded.results[0]?.target).toMatchObject({ span: { content_start: lineEnd,
      content_end: lineEnd + 400, content_complete: false } });
    expect(replay.results).toEqual(expanded.results);
    const executed = await calls.mock.results[1]!.value;
    expect(executed.execution_receipt?.actual?.phases.payload.native_visits).toBeGreaterThan(0);
    expect(executed.execution_receipt?.actual?.phases.payload.native_bytes).toBeGreaterThan(0);
    const old = await call({ ...request, continuation: { ...first.index?.continuation,
      result_version: "ordinary-native-field.v1" } });
    expect(old.index?.completeness.logical_index).toBe("invalidated");
    expect(old.results).toEqual([]);
  });
});

it("refits aligned payload after an actual encoded-envelope shrink without losing source ends", async () => {
  await withIndexedSources(sources, async fixture => {
    const prepared = await fixture.prepareQuery({ navigation: "needle", signal: new AbortController().signal,
      remainingMs: () => 60_000 });
    const readers = createConditionalFieldObserverReaders(fixture.database, [], prepared.vector);
    const request: ConditionalFieldRecallRequest = { workspace_id: WS, query_text: "needle",
      budget: { ...QUERY_BUDGET, page_budget: 2 }, readers, prepared_query: prepared,
      snapshot_id: snapshotIdFromPin(WS, readers.snapshotPin!(WS)), interpretation_clock: CLOCK,
      as_of: CLOCK, expires_at: "2099-01-01T00:00:00.000Z", lifetime_now: CLOCK,
      authorized_scopes: ["project"], enumeration_policy: "native_query", result_kind_view: "source_only",
      ...capableRecallConsumerDeclaration(), delivery_budget: { max_total_tokens: 2000, max_encoded_bytes: 100_000 } };
    let wideBytes = 0;
    const wide = runConditionalFieldRecallWithReceipt({ ...request, delivery_context: `sha256:${fieldContractSha256("wide")}`,
      observe_page_fit: fit => { if (fit.index.entries.length === 2 && fit.fits) wideBytes = fit.bytes; } });
    expect(wide.index.entries).toHaveLength(2);
    expect(wideBytes).toBeGreaterThan(0);
    const attempts: number[] = [];
    const shrunk = runConditionalFieldRecallWithReceipt({ ...request, delivery_context: `sha256:${fieldContractSha256("narrow")}`,
      delivery_budget: { max_total_tokens: 2000, max_encoded_bytes: wideBytes - 1 },
      observe_page_fit: fit => { if (fit.index.entries.length > 0) attempts.push(fit.index.entries.length); } });
    expect(attempts).toEqual([2, 1]);
    expect(shrunk.index.entries).toHaveLength(1);
    const rows = encodeIndexResults(shrunk.index, captureIndexPreviews(shrunk.index, readers, WS),
      2000, captureIndexSourceMetadata(shrunk.index));
    expect(rows[0]?.content_preview).toBe(firstLine);
    expect(rows[0]?.target).toEqual(shrunk.index.entries[0]?.target);
    expect(rows[0]?.target).toMatchObject({ span: { content_end: lineEnd, content_complete: false } });
    expect(() => encodeIndexResults({ ...shrunk.index, result_version: "ordinary-native-field.v1" }))
      .toThrow("ordinary field result version is unsupported");
  });
});

it("prefers imported complete multiline messages over fitting lines in both MCP surfaces and resumes literal bytes", async () => {
  // Independent byte coordinates: first message ends at 715, but a later line ends
  // at 916. Both fit the initial allowance; the next complete message ends at 3717.
  const firstMessage = `${firstLine}inside\n`;
  const body = `${firstMessage}${"tail ".repeat(40)}\n${"tail ".repeat(560)}\n`;
  expect(Buffer.byteLength(firstMessage)).toBe(715);
  expect(Buffer.byteLength(body)).toBe(3717);
  const imported = ["host-first", "host-second"].map(id => ({ id, text: body, vector: [1, 0, 0] }));
  await withIndexedSources(imported, async fixture => {
    const client = await fixture.openClient(), library = publicMcp(client);
    const libraryRequest = { operation: "recall", accepts_unreviewed_conditional_results: true,
      original_query: "needle", semantic_correspondences: [], authorized_scopes: SCOPES,
      budget: { ...QUERY_BUDGET, page_budget: 1 }, output_byte_limit: 100_000 };
    const firstLibrary = await library(libraryRequest);
    if (firstLibrary.operation !== "recall" || firstLibrary.protocol_version !== SOURCE_SEMANTIC_FIELD_LIBRARY_PROTOCOL_VERSION) {
      throw new Error("current field delivery required");
    }
    expect(firstLibrary.results[0]?.content_preview).toBe(firstMessage);
    expect(firstLibrary.results[0]?.target).toMatchObject({ span: { content_start: 0, content_end: 715, content_complete: false } });
    expect(firstLibrary.index.continuation).not.toBeNull();
    const nextRequest = { ...libraryRequest, continuation: firstLibrary.index.continuation };
    const next = await library(nextRequest), replay = await library(nextRequest);
    if (next.operation !== "recall" || next.protocol_version !== SOURCE_SEMANTIC_FIELD_LIBRARY_PROTOCOL_VERSION
      || replay.operation !== "recall" || replay.protocol_version !== SOURCE_SEMANTIC_FIELD_LIBRARY_PROTOCOL_VERSION) {
      throw new Error("current recall required");
    }
    expect(next.results[0]?.content_preview).toBe(firstMessage);
    expect(replay.results).toEqual(next.results);
    expect(replay.index).toEqual({ ...next.index, page_purpose: "retry" });
    const service = new RecallService({ ...createDependencies().dependencies, now: () => CLOCK,
      readSnapshot: client.readSnapshot, conditionalFieldPort: client.conditionalFieldPort,
      activeConstraintsPort: client.activeConstraintsPort });
    const handler = createMcpMemoryToolHandler({ ...createDeps(), now: () => CLOCK, recallService: service });
    const request = { ...capableRecallConsumerDeclaration(), query: "needle", max_results: 1,
      scope_class: "project", dimension: null, domain_tags: null, result_kind_view: "source_only" };
    const call = async (args: object) => {
      const result = await handler.call({ toolName: "soul.recall", arguments: args,
        context: { workspaceId: WS, runId: "run-1", sessionId: "host-message", agentTarget: "codex" } });
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      return SoulMemorySearchResponseSchema.parse(result.output);
    };
    const first = await call(request), target = first.results[0]?.target;
    expect(first.results[0]?.content_preview).toBe(firstMessage);
    expect(target).toMatchObject({ span: { content_start: 0, content_end: 715, content_complete: false } });
    if (target?.kind !== "source_evidence") throw new Error("source target required");
    const expansion = { ...request, continuation: first.index?.continuation,
      payload_continuation: { schema_version: 1, purpose: "payload_expansion", target, start_offset: 715, byte_budget: 400 } };
    const expanded = await call(expansion), expandedReplay = await call(expansion);
    // No positive message end fits: keep the UTF-8 prefix, not the line at 916.
    expect(expanded.results[0]?.content_preview).toBe(Buffer.from(body).subarray(715, 1115).toString("utf8"));
    expect(expanded.results[0]?.target).toMatchObject({ span: { content_start: 715, content_end: 1115, content_complete: false } });
    expect(expandedReplay.results).toEqual(expanded.results);
    const middle = await call({ ...request, continuation: expanded.index?.continuation,
      payload_continuation: { ...expansion.payload_continuation, target: expanded.results[0]!.target,
        start_offset: 1115, byte_budget: 1000 } });
    expect(middle.results[0]?.content_preview).toBe(Buffer.from(body).subarray(1115, 2115).toString("utf8"));
    expect(middle.results[0]?.target).toMatchObject({ span: { content_start: 1115, content_end: 2115, content_complete: false } });
    const final = await call({ ...request, continuation: middle.index?.continuation,
      payload_continuation: { ...expansion.payload_continuation, target: middle.results[0]!.target,
        start_offset: 2115, byte_budget: 4000 } });
    expect(final.results[0]?.content_preview).toBe(Buffer.from(body).subarray(2115).toString("utf8"));
    expect(final.results[0]?.target).toMatchObject({ span: { content_start: 2115, content_end: 3717, content_complete: true } });
  }, undefined, async directory => {
    const daemon = await startBenchDaemon({ dataDirRoot: directory, workspaceId: WS, runId: "run-1",
      configDirectoryRoot: directory, embeddingMode: "disabled", sqliteWriteQueue: "disabled",
      embeddingStartupProbe: "omit", gardenCompute: "disabled", fieldProjectionAdmissionMode: "explicit_checkpoint" });
    try {
      for (const source of imported) {
        const result = await daemon.importSourceRecord({ source_id: source.id, source_version: "1", content_bytes: body,
          recorded_at: CLOCK, event_time: null, valid_from: null, valid_to: null, scope_class: "project",
          spans: [0, 708, 715, 916].map((start, i) => ({ start_offset: start, end_offset: [708, 715, 916, 3717][i]!, purpose: "line" })),
          host_occurrences: [[0, 715], [715, 3717]].map(([start, end], i) => ({ occurrence_id: `authored-${i}`,
            utf8_span: [start!, end!], role: "tool", channel: null, author_ref: null, container_ref: null,
            upstream_message_ref: null, upstream_position: i, completeness: "complete", fidelity: "original_bytes" }))
        }, request => ({ namespace: "authored-host", workspace_id: request.workspace_id,
          producer: "multiline-fixture", basis: "pinned_dataset" }));
        expect(result.spans.filter(span => span.purpose === "message").map(span => span.end_offset)).toEqual([715, 3717]);
      }
    } finally { await daemon.shutdown(); }
  });
});

it("charges native boundary lookup and distinguishes known absence, unreadable and bounded-out facts", async () => {
  await withIndexedSources(sources.slice(0, 1), async fixture => {
    const target = fixture.targets[0]!.target as SourceEvidenceTarget;
    const reader = new SqliteSourceRootRecallReader(new SqliteFieldSourceRecordRepo(fixture.database, fieldContractSha256),
      new SqliteEvidenceCapsuleRepo(fixture.database));
    const baseline = reader.hydrate(WS, target, 1500, 0, 100_000, 1000);
    const aligned = reader.hydrate(WS, target, 1500, 0, 100_000, 1000, true);
    // The second line ends past the hydrated window; delivery never uses it.
    expect(aligned.row?.delivery_boundaries).toEqual({ status: "available", spans: [{ purpose: "line", end_offset: lineEnd }] });
    expect(aligned.nativeWork).toBeGreaterThan(baseline.nativeWork!);
    expect(aligned.metadataBytes).toBeGreaterThan(baseline.metadataBytes!);
    const limited = reader.hydrate(WS, target, 1500, 0, 100_000, baseline.nativeWork!, true);
    expect(limited.row?.delivery_boundaries).toEqual({ status: "unavailable", reason: "resource_limited" });
    fixture.database.connection.prepare("UPDATE source_spans SET producer_version='corrupt' WHERE workspace_id=?").run(WS);
    const unreadable = reader.hydrate(WS, target, 1500, 0, 100_000, 1000, true);
    expect(unreadable.row?.delivery_boundaries).toEqual({ status: "unavailable", reason: "unreadable" });
    expect(unreadable.row?.content).toEqual(baseline.row?.content);
    fixture.database.connection.prepare("DELETE FROM source_spans WHERE workspace_id=?").run(WS);
    const absent = reader.hydrate(WS, target, 1500, 0, 100_000, 1000, true);
    expect(absent.row?.delivery_boundaries).toEqual({ status: "available", spans: [] });
    // The real observer forwards both the native debit and explicit read state.
    const page = createConditionalFieldObserverReaders(fixture.database).sourceRoot!({ purpose: "payload",
      workspaceId: WS, rootKind: target.root_kind, rootId: target.root_id, revision: target.source_version,
      digest: target.content_digest, evidenceObjectId: target.evidence_object_id, byteLimit: 1500,
      workLimit: 1000, nativeByteLimit: 100_000 });
    expect(page.nativeWork).toBe(absent.nativeWork);
    expect(page.metadataBytes).toBe(absent.metadataBytes);
    expect(page.row?.delivery_boundaries).toEqual(absent.row?.delivery_boundaries);
  });
});
