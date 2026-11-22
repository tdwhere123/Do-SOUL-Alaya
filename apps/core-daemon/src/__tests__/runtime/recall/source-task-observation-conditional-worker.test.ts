import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../../scripts/test-support/provider-free/provider-free-boundary.js");
  return installProviderFreeBoundary({
    descendantPreload: new URL("../../../../../../scripts/test-support/provider-free/provider-free-cli-bootstrap.mjs", import.meta.url).href });
});
afterEach(() => { expect(isolation.violations).toEqual([]); isolation.assertSafe(true); vi.restoreAllMocks(); });
afterAll(() => isolation.restore());

import {
  RecallService,
  capableRecallConsumerDeclaration,
  fieldContractSha256,
  SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID
} from "@do-soul/alaya-core";
import {
  QUESTION_TIME_PROPOSAL_PRODUCER_ID,
  sourceSemanticCorrespondenceIdentity,
  SoulMemorySearchResponseSchema,
  SourceSemanticResourceLedger,
  SourceSemanticResourceExhausted,
  type SourceIndexTarget,
  SourceSemanticQuerySchema,
  type SourceTaskAssociation
} from "@do-soul/alaya-protocol";
import { createDependencies } from "../../../../../../packages/core/src/__tests__/recall/recall-service-test-fixtures.js";
import { createDeps } from "../../mcp-memory/tool/mcp-memory-tool-handler-fixture.js";
import { createMcpMemoryToolHandler } from "../../../mcp-memory/tool/tool-handler.js";
import { interpretSourceTaskObservationSourceLocalDecoded, buildSourceTaskObservationRequest } from "../../../../../bench-runner/src/runs/source-task-observation/formation.js";
import { CLOCK, WS, digest, withIndexedSources, SIMULATED_CONFIGURATION, type IndexFixture, publicMcp } from "./source-semantic-index-acquisition.test-support.js";
import { selectedTaskSource, observationEndpointChoice } from "./source-task-observation.test-support.js";
import { publishWireTaskSource, taskQuery as query, taskBody, askedReport, questionTime, recorded, otherReport } from "./source-task-observation-wire.test-support.js";
import { sourceSemanticProofDependencies } from "../../../../../../packages/core/src/recall/runtime/source-semantic-delivery.js";
import { sourceSemanticSupportExtent } from "../../../../../../packages/core/src/memory/evidence-create/source-semantic-support-window.js";
import { receiveAuthoredCorrespondence } from "./source-semantic-producer-fixture.js";

describe("source-task observation conditional worker", () => {
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
  const input = { query, interpretation_clock: CLOCK, question_time: questionTime,
    query_semantics: first.selection.query_semantics, semantic_correspondences: selected.flatMap(row => row.selection.semantic_correspondences),
    sources: selected.map((row, i) => ({ ...row.source, source_ref: `source${i + 1}` })) };
  const result = interpretSourceTaskObservationSourceLocalDecoded(input,
  { rawJson: JSON.stringify({ observations: selected.map((row, i) => ({ source_ref: `source${i + 1}`,
    ...observationEndpointChoice(input, `source${i + 1}`, row.expectedAssociation),
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
    expectedAssociation: { ...selected.expectedAssociation,
      semantic_correspondence_id: sourceSemanticCorrespondenceIdentity(correspondence, fieldContractSha256) } };
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
});

describe("source-task observation endpoint ingress", () => {
const originals = Array.from({ length: 16 }, (_, i) => ({ id: `original-${i}`,
  text: i === 0 ? taskBody : i < 3 ? `${taskBody} Independent record ${i}.` : `${query} Ordinary record ${i}.`,
  eventTime: recorded, vector: [1, 0, 0] }));
const preferred = Array.from({ length: 16 }, (_, i) => ({ id: `preferred-${i}`,
  text: `${query} Dated event ${i}. ${"noise ".repeat(100)}`, eventTime: "2026-09-17T23:00:00.000Z", vector: [-1, 0, 0] }));
const missing = { association_status: "missing", association_ref: null, temporal_operand_status: "missing", temporal_operand_ref: null };
const noTime = { time_status: "unavailable", time_expression: null, time_anchor: null, time_start: null, time_end: null };
type Catalog = { associations: { ref: string; association: SourceTaskAssociation }[];
  temporal_operands: { ref: string; endpoint: { frame: string; slot: string } }[] };
const catalogFor = (input: unknown, index = 0): Catalog => JSON.parse(buildSourceTaskObservationRequest(input).userPrompt).sources[index].endpoint_catalog;
function choice(catalog: Catalog, frame: string, slot: string) {
  const associations = catalog.associations.filter(row => row.association.source_frame === frame);
  const operands = catalog.temporal_operands.filter(row => row.endpoint.frame === frame && row.endpoint.slot === slot);
  expect(associations).toHaveLength(1); expect(operands).toHaveLength(1);
  return { association_status: "selected", association_ref: associations[0]!.ref,
    temporal_operand_status: "selected", temporal_operand_ref: operands[0]!.ref };
}

it("resolves production-shaped opaque endpoints and independently verifies their proof through SQLite, Worker and MCP", async () => {
  await withIndexedSources([...originals, ...preferred], async fixture => {
    const first = await publishWireTaskSource(fixture), second = await publishWireTaskSource(fixture, "original-1", originals[1]!.text);
    const undated = await publishWireTaskSource(fixture, "original-2", originals[2]!.text, false);
    expect(first.selection.query_semantics).toEqual(second.selection.query_semantics);
    const sources = originals.map((source, i) => ({ ...(i === 0 ? first.source : i === 1 ? second.source : {
      target: fixture.targets.find(row => row.source_id === source.id)!.target,
      body: source.text, source_observed_at: source.eventTime }), source_ref: `source${i + 1}` }));
    const input = { query, interpretation_clock: CLOCK, question_time: questionTime,
      query_semantics: first.selection.query_semantics,
      semantic_correspondences: [...first.selection.semantic_correspondences, ...second.selection.semantic_correspondences], sources };
    const catalogs = [catalogFor(input), catalogFor(input, 1)];
    expect(catalogs[0]!.associations).toHaveLength(2);
    expect(catalogs[0]!.temporal_operands).toHaveLength(6);
    const [asked, other] = first.source.selected_interpretation.interpretation.frames;
    const chosen = choice(catalogs[0]!, asked!.id, asked!.slots[2]!.id);
    const wrongEvent = choice(catalogs[0]!, other!.id, other!.slots[2]!.id);
    const secondFrame = second.source.selected_interpretation.interpretation.frames[0]!;
    const secondChoice = choice(catalogs[1]!, secondFrame.id, secondFrame.slots[2]!.id);
    const rows = sources.map(source => ({ ...missing, ...noTime, source_ref: source.source_ref,
      source_excerpt: source.body, query_excerpt: query, utterance_kind: "reported_event", description: "A fallible source report.",
      task_correspondence: "possible", task_role: "task_input", task_component: "reported repair tool" }));
    const dated = { ...rows[0]!, ...chosen, source_excerpt: `${askedReport} ${otherReport}`,
      time_status: "interpreted", time_expression: "September 3", time_anchor: "explicit_date", time_start: "2026-09-03", time_end: "2026-09-03" };
    const form = (observations: readonly object[], captured: unknown = input) => {
      const result = interpretSourceTaskObservationSourceLocalDecoded(captured,
        { rawJson: JSON.stringify({ observations }), finishReason: "stop" }, "step-3.5-2603-low-json-schema-v1");
      if (result.outcome.status !== "source_task_observation") throw new Error(JSON.stringify(result.outcome));
      return result.outcome;
    };
    const formed = form([dated, ...rows.slice(1)]);
    expect(formed.proposal.source_task_observation.status).toBe("ready");
    expect(formed.proposal.source_task_observation.observations.map(row => row.source)).toEqual(sources.map(source => source.target));
    expect(formed.endpoint_selections.slice(1).every(row => row.association_status === "missing")).toBe(true);
    expect(formed.proposal.source_task_observation.observations[0]!.association).toMatchObject({
      source_frame: asked!.id, temporal_operand: { kind: "slot", frame: asked!.id, slot: asked!.slots[2]!.id }, target: { kind: "evidence", input: 0 } });
    let client = await fixture.openClient();
    const handlerFor = (client: Awaited<ReturnType<typeof fixture.openClient>>) => createMcpMemoryToolHandler({
      ...createDeps(), now: () => CLOCK, recallService: new RecallService({ ...createDependencies().dependencies,
        now: () => CLOCK, readSnapshot: client.readSnapshot,
        conditionalFieldPort: client.conditionalFieldPort, activeConstraintsPort: client.activeConstraintsPort }) });
    let handler = handlerFor(client);
    const call = async (interpretation_proposal: unknown, extra: object = {}) => {
      const response = await handler.call({ toolName: "soul.recall", arguments: { ...capableRecallConsumerDeclaration(),
        query, max_results: 5, scope_class: "project", dimension: null, domain_tags: null, result_kind_view: "source_only",
        interpretation_proposal, ...extra }, context: { workspaceId: WS, runId: "run-1", sessionId: "endpoint-ingress", agentTarget: "codex" } });
      if (!response.ok) throw new Error(JSON.stringify(response.error));
      return SoulMemorySearchResponseSchema.parse(response.output);
    };
    const ids = (page: Awaited<ReturnType<typeof call>>) => page.results.map(row => row.target.kind === "source_evidence" ? row.target.root_id : "memory");
    const baselineProposal = { schema_version: 1, producer_id: QUESTION_TIME_PROPOSAL_PRODUCER_ID,
      original_query_digest: digest(query), question_time: questionTime };
    const baseline = await call(baselineProposal);
    const root = first.source.target.root_id;
    expect(ids(baseline)).not.toContain(root);
    const page = await call(formed.proposal);
    expect(ids(page)[0]).toBe(root);
    const qualified = page.index!.entries[0]!.navigation!.task_observation!;
    expect(qualified).toMatchObject({ semantic_status: "unreviewed", world_claim: "unknown", temporal_relation: "hypothesized_disjoint" });
    const target = page.results[0]!.target;
    if (target.kind !== "source_evidence" || target.span === undefined) throw new Error("actual delivered bytes required");
    expect(page.results[0]!.content_preview).toContain(askedReport);
    expect(Buffer.from(taskBody).subarray(target.span.content_start, target.span.content_end).toString("utf8")).toBe(page.results[0]!.content_preview);
    expect(target.span.content_start).toBeLessThanOrEqual(qualified.conditional_binding!.support_span.start_byte);
    expect(target.span.content_end).toBeGreaterThanOrEqual(qualified.conditional_binding!.support_span.end_byte);

    // A catalog-valid source-local endpoint is not proof of the asked event. Nor can its date
    // be attached to the asked frame just because both dates occur in the observation excerpt.
    const lampDate = { time_expression: "September 17", time_start: "2026-09-17", time_end: "2026-09-17" };
    for (const row of [{ ...dated, ...wrongEvent, ...lampDate }, { ...dated, ...lampDate }]) {
      expect(ids(await call(form([row, ...rows.slice(1)]).proposal))).toEqual(ids(baseline));
    }
    for (const status of ["missing", "unresolved", "ambiguous"]) {
      const absent = form([{ ...dated, ...noTime, ...missing, association_status: status }, ...rows.slice(1)]);
      expect(absent.proposal.source_task_observation.status).toBe("ready");
      expect(absent.endpoint_selections[0]!.association_status).toBe(status);
      expect(ids(await call(absent.proposal))).toEqual(ids(baseline));
      const noOperand = form([{ ...dated, ...noTime, temporal_operand_status: status, temporal_operand_ref: null }, ...rows.slice(1)]);
      expect(noOperand.endpoint_selections[0]!.temporal_operand_status).toBe(status);
      const independent = await call(noOperand.proposal);
      expect(ids(independent)[0]).toBe(root);
      expect(independent.index!.entries[0]!.navigation!.task_observation!.temporal_relation).toBe("unavailable");
    }
    // Invalid references isolate the row; they cannot steal a neighbor's choice or an earlier request's address.
    const changedRequest = { ...input, sources: input.sources.map((source, i) => i === 0 ? { ...source, source_observed_at: CLOCK } : source) };
    const crossRequest = choice(catalogFor(changedRequest), asked!.id, asked!.slots[2]!.id);
    for (const [patch, reason] of [
      [{ association_ref: "forged" }, "unknown_association_ref"],
      [{ association_ref: secondChoice.association_ref }, "unknown_association_ref"],
      [{ association_ref: crossRequest.association_ref }, "unknown_association_ref"],
      [{ temporal_operand_ref: secondChoice.temporal_operand_ref }, "unknown_temporal_operand_ref"],
      [{ temporal_operand_ref: crossRequest.temporal_operand_ref }, "unknown_temporal_operand_ref"],
      [{ temporal_operand_ref: wrongEvent.temporal_operand_ref }, "cross_frame_temporal_operand"],
      [{ association_status: "ambiguous" }, "incoherent_endpoint_selection"],
      [{ temporal_operand_ref: null, temporal_operand_status: "missing" }, "interpreted_time_without_operand"]
    ] as const) {
      const partial = form([{ ...dated, ...patch }, { ...rows[1]!, ...secondChoice }, ...rows.slice(2)]);
      expect(partial.diagnostics).toEqual([{ reason, source_ref: "source1", row_index: 0 }]);
      expect(partial.proposal.source_task_observation.status).toBe("partial");
      expect(partial.proposal.source_task_observation.observations).toHaveLength(15);
      const delivered = await call(partial.proposal);
      expect(ids(delivered)[0]).toBe(second.source.target.root_id);
      expect(delivered.results[0]!.content_preview).toContain(askedReport);
      expect(delivered.index!.entries.some(entry => entry.target.kind === "source_evidence"
        && entry.target.root_id === root && entry.navigation?.task_observation !== undefined)).toBe(false);
    }
    // Independent requests retain continuations. Close this group before testing prerequisite
    // and lifecycle cases, rather than raising the real worker's execution-retention capacity.
    await client.close();
    client = await fixture.openClient(); handler = handlerFor(client);
    const noOperandInput = { ...input, semantic_correspondences: undated.selection.semantic_correspondences,
      sources: input.sources.map((source, i) => i === 2 ? { ...undated.source, source_ref: source.source_ref } : source) };
    const undatedCatalog = catalogFor(noOperandInput, 2);
    expect(undatedCatalog.temporal_operands).toHaveLength(4);
    const undatedFrame = undated.source.selected_interpretation.interpretation.frames[0]!;
    const undatedAssociation = undatedCatalog.associations.filter(row => row.association.source_frame === undatedFrame.id);
    expect(undatedAssociation).toHaveLength(1);
    const noOperand = form(rows.map((row, i) => i === 2 ? { ...row, association_status: "selected",
      association_ref: undatedAssociation[0]!.ref } : row), noOperandInput);
    const undatedPage = await call(noOperand.proposal);
    expect(ids(undatedPage)[0]).toBe(undated.source.target.root_id);
    expect(undatedPage.results[0]!.content_preview).toContain(askedReport);
    expect(undatedPage.index!.entries[0]!.navigation!.task_observation!.temporal_relation).toBe("unavailable");
    const unresolvedInput = { ...input, semantic_correspondences: input.semantic_correspondences.map(c => ({ ...c,
      correspondences: c.correspondences.filter(pair => pair.query_endpoint.kind !== "referent") })) };
    const unresolvedChoice = choice(catalogFor(unresolvedInput), asked!.id, asked!.slots[2]!.id);
    expect(ids(await call(form([{ ...dated, ...unresolvedChoice }, ...rows.slice(1)], unresolvedInput).proposal))).toEqual(ids(baseline));
    for (const captured of [{ ...input, query_semantics: undefined }, { ...input, semantic_correspondences: [] },
      { ...input, sources: input.sources.map(source => ({ ...source, selected_interpretation: undefined })) }]) {
      expect(catalogFor(captured).associations).toEqual([]);
      expect(ids(await call(form(rows, captured).proposal))).toEqual(ids(baseline));
    }
    for (const captured of [
      { ...input, sources: input.sources.map((source, i) => i === 0 ? { ...source, selected_interpretation: second.source.selected_interpretation } : source) },
      { ...input, semantic_correspondences: [input.semantic_correspondences[0]!, ...input.semantic_correspondences] },
      { ...input, semantic_correspondences: input.semantic_correspondences.map((c, i) => i === 0
        ? { ...c, query_semantics_id: digest("unrelated query") } : c) }
    ]) {
      expect(catalogFor(captured).associations).toEqual([]);
      const independent = choice(catalogFor(captured, 1), secondFrame.id, secondFrame.slots[2]!.id);
      const retained = form([rows[0]!, { ...rows[1]!, ...independent }, ...rows.slice(2)], captured);
      expect(retained.proposal.source_task_observation.status).toBe("ready");
      expect(retained.proposal.source_task_observation.observations).toHaveLength(16);
      expect(ids(await call(retained.proposal))[0]).toBe(second.source.target.root_id);
    }
    const lifecyclePage = await call(formed.proposal);
    expect(ids(lifecyclePage)[0]).toBe(root);
    await first.withdraw();
    expect(ids(await call(formed.proposal))).toEqual(ids(baseline));
    expect(ids(await call(undefined, { query: "silver wrench" }))).toContain(root);
    expect((await call(formed.proposal, { continuation: lifecyclePage.index!.continuation })).index!.completeness.logical_index).toBe("invalidated");
    const secondForm = form([rows[0]!, { ...rows[1]!, ...secondChoice }, ...rows.slice(2)]);
    await fixture.admit({ id: "original-1", text: "Replacement source record.", eventTime: CLOCK }, "2");
    const stale = await call(secondForm.proposal);
    expect(stale.index!.entries.every(entry => entry.navigation?.task_observation === undefined)).toBe(true);
    expect(stale.results).toEqual((await call(baselineProposal)).results);
  }, { ...SIMULATED_CONFIGURATION, profile: { ...SIMULATED_CONFIGURATION.profile, max_input_tokens: 4096 } });
}, 120_000);
});
