import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../../scripts/test-support/provider-free/provider-free-boundary.js");
  return installProviderFreeBoundary({
    descendantPreload: new URL("../../../../../../scripts/test-support/provider-free/provider-free-cli-bootstrap.mjs", import.meta.url).href });
});
afterEach(() => { expect(isolation.violations).toEqual([]); isolation.assertSafe(true); });
afterAll(() => isolation.restore());
import { RecallService, capableRecallConsumerDeclaration } from "@do-soul/alaya-core";
import { QUESTION_TIME_PROPOSAL_PRODUCER_ID, SoulMemorySearchResponseSchema, type SourceTaskAssociation }
  from "@do-soul/alaya-protocol";
import { createDependencies } from "../../../../../../packages/core/src/__tests__/recall/recall-service-test-fixtures.js";
import { createDeps } from "../../mcp-memory/tool/mcp-memory-tool-handler-fixture.js";
import { createMcpMemoryToolHandler } from "../../../mcp-memory/tool/tool-handler.js";
import { buildSourceTaskObservationRequest, interpretSourceTaskObservationSourceLocalDecoded }
  from "../../../../../bench-runner/src/runs/source-task-observation/formation.js";
import { CLOCK, WS, digest, withIndexedSources, SIMULATED_CONFIGURATION } from "./source-semantic-index-acquisition.test-support.js";
import { publishWireTaskSource, taskQuery as query, taskBody, askedReport, otherReport, questionTime, recorded }
  from "./source-task-observation-wire.test-support.js";

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
