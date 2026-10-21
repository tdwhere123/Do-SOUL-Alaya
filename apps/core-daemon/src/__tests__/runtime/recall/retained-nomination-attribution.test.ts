import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); });
afterAll(() => { isolation.restore(); });
import type { SourceSemanticObservation } from "../../../runtime/recall-read-worker/source-semantic-observation.js";
import { SourceSemanticProfiledAcquisitionPhaseSchema, SourceSemanticRetainedNominationWitnessSchema,
  sourceSemanticRetainedWitnessMatchesPhase, type SourceSemanticAccessProfile } from "@do-soul/alaya-protocol";
import { createMcpMemoryToolHandler } from "../../../mcp-memory/tool/tool-handler.js";
import { bindSourceComparisonExecution, sourceComparisonForRuntime } from "../../../runtime/recall/source-comparison-execution.js";
import { createDeps } from "../../mcp-memory/tool/mcp-memory-tool-handler-fixture.js";
import { withIndexedSources, CLOCK, WS, SCOPES, QUERY_BUDGET } from "./source-semantic-index-acquisition.test-support.js";
import { attributeObservation, type ObservationCallScope } from "../../../../../bench-runner/src/runs/longmemeval-semantic/observation-attribution.js";
import { scoreConsumerMessageVisibility } from "../../../../../bench-runner/src/runs/longmemeval-semantic/message-visibility.js";

const profile: SourceSemanticAccessProfile = { contract: "source-semantic-access-v3", result_version: "source-semantic-library-v7",
  protocol_version: 9, order_policy: "native-route-round-robin-v1", acquisition_policy: "source-index-grouped-round-robin.v1",
  channels: "dual", declared_allowance: { max_attempts: 128, max_roots: 20, max_vector_windows: 4096 } };

it("attributes beyond-prefix nominations from the SQLite/built-worker witness after optional diagnostic elision", async () => {
  // Synthetic indexed inputs and fixed-axis vectors use real SQLite admission/acquisition and the built worker.
  // Diagnostic elision below is explicit post-capture fault injection, not natural-corpus measurement.
  await withIndexedSources(Array.from({ length: 20 }, (_, index) => ({ id: `retained-${index}`,
    text: `needle proof ${index}`, vector: [1, 0, 0] })), async fixture => {
    const client = await fixture.openClient();
    const handler = createMcpMemoryToolHandler({ ...createDeps(), now: () => CLOCK, sourceSemanticsPort: client.sourceSemanticsPort });
    const runtime = {};
    bindSourceComparisonExecution(runtime, handler, client.sourceSemanticsPort!);
    const execute = sourceComparisonForRuntime(runtime, () => ({ workspaceId: WS, runId: "retained-proof",
      sessionId: "retained-proof", agentTarget: "bench-runner" }));
    const observed = await client.observeSourceSemantics({ max_events: 2048, max_bytes: 524288 }, () => execute({ profile,
      request: { operation: "prepare_query", original_query: "needle", access_hint: "proof", authorized_scopes: SCOPES,
        budget: { ...QUERY_BUDGET, work_units: 2000000, memory_bytes: 20000000 } } }));
    if (observed.outcome.status !== "success") throw observed.outcome.error;
    const captured = structuredClone(observed.observations[0]!);
    const event = captured.events.find(row => row.kind === "source_index_routes")!;
    const data = event.data as { candidate_phase?: unknown; retained_occurrences?: unknown };
    const phase = SourceSemanticProfiledAcquisitionPhaseSchema.parse(data.candidate_phase);
    const witness = SourceSemanticRetainedNominationWitnessSchema.parse(data.retained_occurrences);
    expect(sourceSemanticRetainedWitnessMatchesPhase(witness, phase)).toBe(true);
    expect(phase.result!.counts).toEqual({ attempts: 80, retained_occurrences: 80, distinct_roots: 20,
      duplicate_occurrences: 60, denied: 0, unknown: 0, nomination_limit: 0,
      resource_refused_before_start: 0, resource_refused_after_start: 0 });
    expect(phase.result!.lanes.map(row => row.consumed_occurrences)).toEqual([20, 20, 20, 20]);
    expect(phase.result!.vector.inspected_windows).toBe(40);
    expect(phase.result!.occurrence_prefix).toHaveLength(16);
    expect(phase.result!.prefix_coverage.omitted_occurrences).toBe(64);
    const displayed = new Set(phase.result!.occurrence_prefix.map(row => row.source.root_key));
    const beyond = witness.find(row => !displayed.has(row.source.root_key))!;
    expect(beyond).toBeDefined();
    const frame = { ...captured, events: captured.events.filter(row => row.kind !== "source_index_acquisition") };
    expect(frame.events.find(row => row.kind === "source_index_routes")).toEqual(event);
    const answer = { unit: "published_body_utf8_bytes" as const, annotated_turns: 1, complete: true,
      spans: [{ session_index: 0, message_index: 0, source_id: beyond.source.source_id,
        target: { ...beyond.source.target, root_kind: "source_record" as const }, start: 0, end: 1 }] };
    const call: ObservationCallScope = { kind: "prepare_query", request_id: frame.request_id,
      session_id: frame.facts!.binding!.session_id, query_key: "synthetic", snapshot_id: null, workspace_id: WS, as_of: CLOCK };
    const project = (observation: SourceSemanticObservation) => attributeObservation({ question_id: "synthetic", k: 5, call,
      frames: [{ call, observation }], frozen_index: null, admitted_roots: new Map(), admitted_roots_complete: false, answer_gold: answer,
      visibility: scoreConsumerMessageVisibility({ gold: answer, pages: [] }) });
    const result = project(frame);
    for (const view of ["original", "hint"] as const) for (const channel of ["lexical", "vector"] as const) {
      const fact = result.messages[0]!.routes.find(row => row.route === `index:${view}:${channel}`)!;
      const retained = witness.filter(row => row.source.root_key === beyond.source.root_key && row.view === view && row.route.kind === channel);
      expect(retained).toHaveLength(1);
      expect(fact).toMatchObject({ nomination: "passed", eligibility: "unknown", native: {
        occurrence_evidence: "full_retained", retained_occurrences: retained, attempts: null } });
      const native = retained[0]!.route;
      if (native.kind === "lexical") expect(fact.native?.lexical_ranks).toEqual([
        { rank: native.native_rank, lane: native.lane, lane_rank: native.lane_rank, bm25: native.bm25 }]);
      else {
        expect(native.window?.status).toBe("available");
        if (native.window?.status === "available") expect(fact.native?.vector).toEqual({ rank: native.native_rank,
          cosine: native.cosine, window: native.window.window });
      }
    }
    expect(result.messages[0]).toMatchObject({ eligibility: "unknown", visibility: { delivery: "unknown" },
      finite_union: { full_universe: "not_established" } });
    // Labelled synthetic post-capture faults: not natural input or a measured retrieval claim.
    for (const facts of [undefined, { ...frame.facts!, binding: null }, { ...frame.facts!,
      binding: { ...frame.facts!.binding!, session_id: "foreign" } }]) {
      const unbound = project({ ...frame, facts });
      expect(unbound.observation).toMatchObject({ complete: false, progress_complete: false, finite_union_complete: false });
      for (const route of unbound.messages[0]!.routes.filter(row => row.route.startsWith("index:"))) {
        expect(route).toMatchObject({ nomination: "unknown", first_failure: null, native: { lexical_ranks: null,
          vector: null, retained_occurrences: null, occurrence_evidence: "unavailable", completion: null, attempts: null } });
      }
    }
    const partial = project({ ...frame, facts: { ...frame.facts!, complete: false, issues: ["synthetic_detail_omitted"] },
      status: "overflow", dropped_events: 1 });
    expect(partial.observation.progress_complete).toBe(false);
    for (const route of partial.messages[0]!.routes.filter(row => row.route.startsWith("index:"))) {
      const original = result.messages[0]!.routes.find(row => row.route === route.route)!;
      expect(route.nomination).toBe("passed");
      expect(route.native).toEqual(original.native);
    }
  });
}, 60000);
