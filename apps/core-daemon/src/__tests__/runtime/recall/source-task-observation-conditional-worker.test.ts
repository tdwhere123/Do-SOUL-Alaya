import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary({
    descendantPreload: new URL("../../../../../bench-runner/src/__tests__/support/provider-free-cli-bootstrap.mjs", import.meta.url).href });
});
afterEach(() => { expect(isolation.violations).toEqual([]); isolation.assertSafe(true); });
afterAll(() => isolation.restore());
import { RecallService, capableRecallConsumerDeclaration, fieldContractSha256,
  SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID } from "@do-soul/alaya-core";
import { SourceSemanticQuerySchema, sourceSemanticCorrespondenceIdentity, SoulMemorySearchResponseSchema,
  SourceSemanticResourceLedger, SourceSemanticResourceExhausted, type SourceIndexTarget } from "@do-soul/alaya-protocol";
import { sourceSemanticProofDependencies } from "../../../../../../packages/core/src/recall/runtime/source-semantic-delivery.js";
import { sourceSemanticSupportExtent } from "../../../../../../packages/core/src/memory/evidence-create/source-semantic-support-window.js";
import { createDependencies } from "../../../../../../packages/core/src/__tests__/recall/recall-service-test-fixtures.js";
import { createDeps } from "../../mcp-memory/tool/mcp-memory-tool-handler-fixture.js";
import { createMcpMemoryToolHandler } from "../../../mcp-memory/tool/tool-handler.js";
import { interpretSourceTaskObservationSourceLocalDecoded } from "../../../../../bench-runner/src/runs/source-task-observation/formation.js";
import { CLOCK, WS, withIndexedSources, SIMULATED_CONFIGURATION, publicMcp, type IndexFixture }
  from "./source-semantic-index-acquisition.test-support.js";
import { selectedTaskSource } from "./source-task-observation.test-support.js";
import { receiveAuthoredCorrespondence } from "./source-semantic-producer-fixture.js";

type Selected = Awaited<ReturnType<typeof selectedTaskSource>>;
const questionTime = { interpretation_clock: CLOCK, intervals: [{ start: "2026-09-17", end: "2026-09-17" }] };
const recorded = "2026-09-08T00:00:00.000Z";
const configuration = { ...SIMULATED_CONFIGURATION, profile: { ...SIMULATED_CONFIGURATION.profile, max_input_tokens: 4096 } };
const budget = { schema_version: 1 as const, work_units: 2_000_000, memory_bytes: 32_000_000,
  page_budget: 100_000, finalization_reserve: 10_000, min_envelope: 10 };
const noTime = { time_status: "unavailable", time_expression: null, time_anchor: null, time_start: null, time_end: null };
const dated = (expression: string, date: string) => ({ time_status: "interpreted", time_expression: expression,
  time_anchor: "explicit_date", time_start: date, time_end: date });

function competingSources(query: string, reports: readonly string[]) {
  return [...Array.from({ length: 16 }, (_, i) => ({ id: `original-${i}`,
    text: reports[i] ?? `${query} ordinary memory ${i}.`, eventTime: recorded, vector: [1, 0, 0] })),
  ...Array.from({ length: 16 }, (_, i) => ({ id: `preferred-${i}`, text: `${query} dated event ${i}. ${"noise ".repeat(100)}`,
    eventTime: "2026-09-17T23:00:00.000Z", vector: [-1, 0, 0] }))];
}

function form(query: string, selected: readonly Selected[], times: readonly object[] = selected.map(() => noTime)) {
  const first = selected[0]!;
  const result = interpretSourceTaskObservationSourceLocalDecoded({ query, interpretation_clock: CLOCK, question_time: questionTime,
    query_semantics: first.selection.query_semantics, semantic_correspondences: selected.flatMap(row => row.selection.semantic_correspondences),
    sources: selected.map((row, i) => ({ ...row.source, source_ref: `source${i + 1}` })) },
  { rawJson: JSON.stringify({ observations: selected.map((row, i) => ({ source_ref: `source${i + 1}`,
    source_excerpt: row.source.body, query_excerpt: query, utterance_kind: "reported_event", description: "A conditional source report.",
    task_correspondence: "possible", task_role: "task_input", task_component: "reported tool", ...times[i] })) }), finishReason: "stop" },
  "step-3.5-2603-low-json-schema-v1");
  if (result.outcome.status !== "source_task_observation") throw new Error(JSON.stringify(result.outcome));
  return result.outcome.proposal;
}

async function openRecall(fixture: IndexFixture, query: string) {
  const client = await fixture.openClient();
  const handler = createMcpMemoryToolHandler({ ...createDeps(), now: () => CLOCK, recallService: new RecallService({
    ...createDependencies().dependencies, now: () => CLOCK, readSnapshot: client.readSnapshot,
    conditionalFieldPort: client.conditionalFieldPort, activeConstraintsPort: client.activeConstraintsPort }) });
  const call = async (proposal: unknown, extra: object = {}) => {
    const result = await handler.call({ toolName: "soul.recall", arguments: { ...capableRecallConsumerDeclaration(),
      query, max_results: 5, scope_class: "project", dimension: null, domain_tags: null, result_kind_view: "source_only",
      interpretation_proposal: proposal, ...extra }, context: { workspaceId: WS, runId: "run-1",
      sessionId: "conditional-task-inputs", agentTarget: "codex" } });
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    return SoulMemorySearchResponseSchema.parse(result.output);
  };
  return { client, call, reason: publicMcp(client) };
}

function withIndependentInput(selected: Selected, query: string): Selected {
  const original = selected.selection.query_semantics, alternative = original.alternatives[0]!;
  const semantics = SourceSemanticQuerySchema.parse({ ...original,
    variables: [...original.variables, { id: "otherEvent", sort: "proposition" }, { id: "otherTool", sort: "entity" }],
    alternatives: [{ ...alternative, frames: [...alternative.frames, { id: "otherTask", variable: "otherEvent",
      predicate_reading: "fixed", role_requirements: [{ id: "tool", role_reading: "tool", target_variable: "otherTool",
        support: { kind: "query_text", excerpt: "tools" } }] }],
      context_obligations: [...alternative.context_obligations, { frame: "otherTask", kind: "asserted_at_source" }],
      evidence_inputs: [...alternative.evidence_inputs!, { frames: ["otherTask"] }] }] });
  const received = receiveAuthoredCorrespondence({ original_query: query, admitted_query_semantics: semantics,
    source_interpretation_descriptors: [{ source_interpretation_id: selected.source.selected_interpretation.interpretation_id,
      interpretation: selected.source.selected_interpretation.interpretation }],
    producer_id: SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID, producer_version: "1" },
  { correspondences: [...selected.selection.semantic_correspondences[0]!.correspondences,
    { relation: "contextual_equivalence", query_endpoint: { kind: "predicate", alternative: 0, frame: "otherTask" },
      source_endpoint: { kind: "frame", frame: "lamp" }, query_support: { kind: "query_text", excerpt: "fix the lamp" }, source_semantic_support: [] },
    { relation: "contextual_equivalence", query_endpoint: { kind: "slot", alternative: 0, frame: "otherTask", slot: "tool" },
      source_endpoint: { kind: "slot", frame: "lamp", slot: "tool" }, query_support: { kind: "query_text", excerpt: "tools" }, source_semantic_support: [] }] });
  if (received.semantic_correspondence === undefined) throw new Error(JSON.stringify(received.outcome));
  const correspondence = received.semantic_correspondence;
  return { ...selected, selection: { query_semantics: semantics, semantic_correspondences: [correspondence] },
    source: { ...selected.source, association: { ...selected.source.association,
      semantic_correspondence_id: sourceSemanticCorrespondenceIdentity(correspondence, fieldContractSha256) } } };
}

function assertVisible(page: Awaited<ReturnType<Awaited<ReturnType<typeof openRecall>>["call"]>>, selected: Selected) {
  const entry = page.index!.entries.find(entry => entry.target.kind === "source_evidence"
    && entry.target.root_id === selected.source.target.root_id)!;
  expect(entry?.navigation?.task_observation).toMatchObject({ semantic_status: "unreviewed", world_claim: "unknown" });
  const visible = page.results.find(result => result.target.kind === "source_evidence"
    && result.target.root_id === selected.source.target.root_id)!;
  if (visible?.target.kind !== "source_evidence" || visible.target.span === undefined) throw new Error("delivered source span required");
  expect(visible.content_preview).toBe(Buffer.from(selected.source.body)
    .subarray(visible.target.span.content_start, visible.target.span.content_end).toString("utf8"));
  const support = entry.navigation!.task_observation!.conditional_binding!.support_span;
  expect(visible.target.span.content_start).toBeLessThanOrEqual(support.start_byte);
  expect(visible.target.span.content_end).toBeGreaterThanOrEqual(support.end_byte);
  return entry.navigation!.task_observation!;
}

it.each(["none", "independent", "selected"] as const)(
  "preserves exact executed IDs and selected proof support with %s unexpressed input", async unexpressed => {
    const query = "What tools were used to repair the hinge and fix the lamp last Thursday?";
    const repair = unexpressed === "selected" ? "The hinge was repaired." : "I repaired the hinge with a silver wrench.";
    const lamp = unexpressed === "independent" ? "The lamp was fixed." : "I fixed the lamp with a blue wrench.";
    const body = `${query} ${repair} ${lamp}`;
    await withIndexedSources(competingSources(query, [body]), async fixture => {
      const selected = await selectedTaskSource(fixture, { sourceId: "original-0", body, observedAt: recorded, query,
        selectedFrame: "repair", evidence: true,
        frames: [{ id: "repair", text: repair, predicate: "repaired", roles: [{ id: "tool", text: "silver wrench",
          unexpressed: unexpressed === "selected" }] },
        { id: "lamp", text: lamp, predicate: "fixed", roles: [{ id: "tool", text: "blue wrench",
          unexpressed: unexpressed === "independent" }] }], roles: [{ id: "tool", queryExcerpt: "tools" }] });
      const native = await openRecall(fixture, query);
      if (unexpressed !== "selected") assertVisible(await native.call(form(query, [selected])), selected);
      const combined = withIndependentInput(selected, query);
      const proof = await native.reason({ operation: "reason", accepts_unreviewed_conditional_results: true,
        original_query: query, query_semantics: combined.selection.query_semantics,
        source_interpretation_id: combined.source.selected_interpretation.interpretation_id,
        semantic_correspondence: combined.selection.semantic_correspondences[0], budget, output_byte_limit: 1_000_000,
        authorized_scopes: { mode: "named", scopes: ["project"] } });
      if (proof.operation !== "reason" || proof.result === undefined) throw new Error("executed reason result required");
      expect(proof.result.outcome.status).toBe("interpreted");
      expect(proof.result.binding_results?.map(binding => binding.kind === "evidence" ? binding.input : -1)).toEqual([0, 1]);
      const [a, b] = proof.result.binding_results!;
      expect(a!.binding_id.startsWith("g0:")).toBe(true);
      expect(a!.bindings.event?.node_id).toBe("repair");
      expect(b!.bindings.otherTool?.node_id).toBe("lamptool");
      const meter = new SourceSemanticResourceLedger(budget);
      const allSupport = sourceSemanticSupportExtent(combined.source.selected_interpretation.interpretation,
        sourceSemanticProofDependencies(proof.result, meter), meter);
      expect(allSupport.status).toBe(unexpressed === "none" ? "located" : "unavailable");
      if (unexpressed !== "none") expect(allSupport).toEqual({ status: "unavailable", reason: "location_missing" });
      const page = await native.call(form(query, [combined]));
      if (unexpressed === "selected") {
        expect(page.index!.entries.every(entry => entry.navigation?.task_observation === undefined)).toBe(true);
        expect(page.index!.entries.every(entry => entry.target.kind !== "source_evidence"
          || entry.target.root_id !== combined.source.target.root_id)).toBe(true);
        const raw = await native.call(undefined, { query: "repaired" });
        expect(raw.results.some(row => row.target.kind === "source_evidence"
          && row.target.root_id === combined.source.target.root_id)).toBe(true);
        return;
      }
      const selectedDependencies = sourceSemanticProofDependencies(proof.result, meter, a!.binding_id);
      expect(selectedDependencies).toContain("repairtool");
      expect(selectedDependencies).not.toContain("lamptool");
      expect(meter.spentWork).toBeGreaterThan(0);
      expect(meter.spentBytes).toBeGreaterThan(0);
      expect(() => sourceSemanticProofDependencies(proof.result!,
        new SourceSemanticResourceLedger({ work_units: 0, memory_bytes: 0 }), a!.binding_id)).toThrow(SourceSemanticResourceExhausted);
      const qualification = assertVisible(page, combined);
      expect(qualification.conditional_binding!.binding_id).toBe(a!.binding_id);
      expect(qualification.conditional_binding!.conditional_computation_id).toBe(proof.result.conditional_computation_id);
      expect(page.results.find(result => result.target.kind === "source_evidence"
        && result.target.root_id === combined.source.target.root_id)!.content_preview).toContain(repair);
    }, configuration);
  }, 60_000);

it("uses bound source dates to reorder two qualified reports without changing record clocks or Q/H/C", async () => {
  const query = "What tool did I use to repair the hinge last Thursday?";
  const reports = ["I repaired the hinge with a silver wrench on September 3, 2026.",
    "I repaired the hinge with a bronze wrench on September 17, 2026."];
  const bodies = [`${query} ${query} ${reports[0]}`, `${query} ${reports[1]}`];
  await withIndexedSources(competingSources(query, bodies), async fixture => {
    const selected: Selected[] = [];
    for (const [i, body] of bodies.entries()) selected.push(await selectedTaskSource(fixture, {
      sourceId: `original-${i}`, body, observedAt: recorded, query, selectedFrame: "repair", evidence: true, temporalSlot: "date",
      frames: [{ id: "repair", text: reports[i]!, predicate: "repaired", roles: [
        { id: "tool", text: i === 0 ? "silver wrench" : "bronze wrench" },
        { id: "date", text: i === 0 ? "September 3, 2026" : "September 17, 2026" }] }],
      roles: [{ id: "tool", queryExcerpt: "What tool" }] }));
    expect(selected[0]!.selection.query_semantics).toEqual(selected[1]!.selection.query_semantics);
    const native = await openRecall(fixture, query), unknown = form(query, selected);
    const observed = await native.client.observeSourceSemantics({ max_events: 2048, max_bytes: 524288 }, () => native.call(unknown));
    if (observed.outcome.status !== "success") throw observed.outcome.error;
    const page = observed.outcome.value;
    const inventory = observed.observations.flatMap(frame => frame.events).filter(event => event.kind === "source_index_acquisition")
      .map(event => event.data).find(data => (data as { kind?: string }).kind === "source_task_inventory") as
      { original: readonly SourceIndexTarget[] } | undefined;
    const roots = selected.map(row => row.source.target.root_id);
    const originalOrder = inventory!.original.map(row => row.target.root_id).filter(root => roots.includes(root));
    expect(originalOrder).toEqual(roots);
    const order = (value: typeof page) => value.index!.entries.filter(entry => entry.navigation?.task_observation !== undefined)
      .map(entry => entry.target.kind === "source_evidence" ? entry.target.root_id : "memory");
    expect(order(page)).toEqual(originalOrder);
    for (const row of selected) expect(assertVisible(page, row).temporal_relation).toBe("unavailable");
    const known = form(query, selected, [dated("September 3, 2026", "2026-09-03"), dated("September 17, 2026", "2026-09-17")]);
    expect(known.source_task_observation.query_semantics).toEqual(unknown.source_task_observation.query_semantics);
    expect(known.source_task_observation.semantic_correspondences).toEqual(unknown.source_task_observation.semantic_correspondences);
    expect(known.source_task_observation.observations.map(({ event_time: _time, ...row }) => row))
      .toEqual(unknown.source_task_observation.observations.map(({ event_time: _time, ...row }) => row));
    const reordered = await native.call(known);
    expect(order(reordered)).toEqual([...originalOrder].reverse());
    for (const [i, row] of selected.entries()) {
      const qualification = assertVisible(reordered, row);
      expect(qualification.temporal_relation).toBe(i === 0 ? "hypothesized_disjoint" : "hypothesized_overlap");
      expect(qualification.conditional_binding).toEqual(assertVisible(page, row).conditional_binding);
    }
    expect(reordered.results[0]!.content_preview).toContain(reports[1]);
    expect(page.results[0]!.content_preview).toContain(reports[0]);
    expect((await native.call(known)).results).toEqual(reordered.results);
  }, configuration);
}, 60_000);
