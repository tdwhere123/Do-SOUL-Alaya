import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary({
    descendantPreload: new URL("../../../../../bench-runner/src/__tests__/support/provider-free-cli-bootstrap.mjs", import.meta.url).href });
});
afterEach(() => { expect(isolation.violations).toEqual([]); isolation.assertSafe(true); });
afterAll(() => isolation.restore());
import { SourceSemanticCorrespondenceSchema, sourceSemanticQueryIdentity, SourceTaskObservationFormationInputSchema,
  SoulMemorySearchResponseSchema, QUESTION_TIME_PROPOSAL_PRODUCER_ID } from "@do-soul/alaya-protocol";
import { admitSourceSemanticCorrespondence, fieldContractSha256,
  SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID, RecallService, capableRecallConsumerDeclaration } from "@do-soul/alaya-core";
import { publishAuthoredTaskSource } from "./source-task-observation.test-support.js";
import { createDependencies } from "../../../../../../packages/core/src/__tests__/recall/recall-service-test-fixtures.js";
import { createDeps } from "../../mcp-memory/tool/mcp-memory-tool-handler-fixture.js";
import { createMcpMemoryToolHandler } from "../../../mcp-memory/tool/tool-handler.js";
import { buildSourceTaskObservationRequest, interpretSourceTaskObservationSourceLocalDecoded }
  from "../../../../../bench-runner/src/runs/source-task-observation/formation.js";
import { CLOCK, WS, digest, withIndexedSources, SIMULATED_CONFIGURATION, type IndexFixture }
  from "./source-semantic-index-acquisition.test-support.js";
import { publishWireTaskSource, taskQuery as query, taskBody, askedReport, questionTime, recorded }
  from "./source-task-observation-wire.test-support.js";

const terms = ["hinge", "silver wrench", "bayA", "partB", "partC", "partD", "partE", "partF"];
const reports = Array.from({ length: 16 }, (_, i) => `Repair${i} repaired the hinge with silver wrench at bayA using partB near partC plus partD under partE beside partF.`);
const largeBody = `${query} ${reports.join(" ")}`;
const noSelection = { association_status: "unresolved", association_ref: null,
  temporal_operand_status: "unresolved", temporal_operand_ref: null };
const observation = (source_ref: string, source_excerpt: string) => ({ source_ref, source_excerpt, query_excerpt: query,
  ...noSelection, utterance_kind: "reported_event", description: "A fallible report with endpoint availability unresolved.",
  task_correspondence: "possible", task_role: "task_input", task_component: "reported repair tool",
  time_status: "unavailable", time_expression: null, time_anchor: null, time_start: null, time_end: null });

async function publishLargeSource(fixture: IndexFixture, q: Awaited<ReturnType<typeof publishWireTaskSource>>["selection"]["query_semantics"]) {
  const { published } = await publishAuthoredTaskSource(fixture, { sourceId: "original-1", body: largeBody,
    frames: reports.map((text, i) => ({ id: `f${i}`, text, predicate: "repaired",
      roles: terms.slice(0, i === 15 ? 1 : 8).map((text, j) => ({ id: `r${j}`, text })) })) });
  const h = published.bound.interpretation, frame = h.frames[0]!, qFrame = q.alternatives[0]!.frames[0]!;
  expect(h.frames).toHaveLength(16);
  expect(h.frames.reduce((count, frame) => count + frame.slots.length, 0)).toBe(121);
  expect(h.referents.filter(row => row.referent_kind === "grouped")).toHaveLength(121);
  expect(published.evidence.gist.length).toBeLessThanOrEqual(65_536);
  // Manual canonical C is a supported admission surface; its validity does not require the
  // producer's aggregate endpoint catalog. It references only one of the 16 lawful H frames (258 catalog endpoints including referents).
  const hinge = frame.bindings[0]!.target;
  if (hinge.kind !== "node") throw new Error("large fixture referent must be bound");
  const c = SourceSemanticCorrespondenceSchema.parse({ contract: "source-semantic-correspondence-v3",
    source_interpretation_id: published.bound.interpretation_id, query_semantics_id: sourceSemanticQueryIdentity(q, fieldContractSha256),
    producer_id: SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID, producer_version: "1", contract_version: "source-semantic-correspondence-v3",
    correspondences: [
      { relation: "contextual_equivalence", query_endpoint: { kind: "predicate", alternative: 0, frame: qFrame.id },
        source_endpoint: { kind: "frame", frame: frame.id }, query_support: { kind: "query_text", excerpt: "repair" }, source_semantic_support: [] },
      ...qFrame.role_requirements.map((role, i) => ({ relation: "contextual_equivalence",
        query_endpoint: { kind: "slot", alternative: 0, frame: qFrame.id, slot: role.id },
        source_endpoint: { kind: "slot", frame: frame.id, slot: frame.slots[i]!.id }, query_support: role.support, source_semantic_support: [] })),
      { relation: "contextual_equivalence", query_endpoint: { kind: "referent", variable: qFrame.role_requirements[0]!.target_variable },
        source_endpoint: { kind: "referent", referent: hinge.id }, query_support: { kind: "query_text", excerpt: "the hinge" }, source_semantic_support: [] }
    ] });
  expect(admitSourceSemanticCorrespondence({ original_query: query, query_semantics: q,
    source_interpretation: h, semantic_correspondence: c }).kind).toBe("admitted");
  return { source: { source_ref: "source1", body: largeBody, target: published.bound.source_target,
    source_observed_at: recorded, selected_interpretation: published.bound }, correspondence: c };
}

it.each(["request", "decoded"] as const)("isolates catalog capacity during %s formation without losing neighboring source evidence", async stage => {
  const originals = Array.from({ length: 16 }, (_, i) => ({ id: `original-${i}`, eventTime: recorded, vector: [1, 0, 0],
    text: i === 0 ? taskBody : i === 1 ? largeBody : `${query} Ordinary record ${i}.` }));
  const preferred = Array.from({ length: 16 }, (_, i) => ({ id: `preferred-${i}`, text: `${query} Dated event ${i}. ${"noise ".repeat(100)}`,
    eventTime: "2026-09-17T23:00:00.000Z", vector: [-1, 0, 0] }));
  await withIndexedSources([...originals, ...preferred], async fixture => {
    const useful = await publishWireTaskSource(fixture), large = await publishLargeSource(fixture, useful.selection.query_semantics);
    const input = { query, interpretation_clock: CLOCK, question_time: questionTime, query_semantics: useful.selection.query_semantics,
      semantic_correspondences: [large.correspondence, ...useful.selection.semantic_correspondences],
      sources: [large.source, { ...useful.source, source_ref: "source2" }] };
    expect(SourceTaskObservationFormationInputSchema.safeParse(input).success).toBe(true);
    const decode = (rows: object[]) => interpretSourceTaskObservationSourceLocalDecoded(input,
      { rawJson: JSON.stringify({ observations: rows }), finishReason: "stop" }, "step-3.5-2603-low-json-schema-v1");
    const rows = [observation("source1", reports[0]!), observation("source2", askedReport)];
    if (stage === "decoded") {
      const formed = decode(rows);
      expect(formed).toMatchObject({ admitted: true, outcome: { diagnostics: [],
        endpoint_selections: [{ source_ref: "source1", catalog_reason: "endpoint_catalog_capacity_exhausted",
          catalog_capacity: { endpoint_kind: "source", limit: 256, attempted: 257 } },
          { source_ref: "source2", catalog_reason: null }],
        proposal: { source_task_observation: { status: "ready", observations: [
          { source: large.source.target }, { source: useful.source.target }] } } } });
      return;
    }
    const request = buildSourceTaskObservationRequest(input);
    const visible = JSON.parse(request.userPrompt);
    expect(visible.sources[0].endpoint_catalog).toMatchObject({ reason: "endpoint_catalog_capacity_exhausted",
      capacity: { endpoint_kind: "source", limit: 256, attempted: 257 }, associations: [], temporal_operands: [] });
    const choices = visible.sources[1].endpoint_catalog.associations.filter((row: { association: { source_frame: string } }) =>
      row.association.source_frame === useful.source.selected_interpretation.interpretation.frames[0]!.id);
    expect(choices).toHaveLength(1);
    const formed = decode([rows[0]!, { ...rows[1]!, association_status: "selected", association_ref: choices[0].ref }]);
    if (formed.outcome.status !== "source_task_observation") throw new Error(JSON.stringify(formed.outcome));
    expect(formed.outcome.proposal.source_task_observation.status).toBe("ready");
    expect(formed.outcome.proposal.source_task_observation.observations.map(row => row.source)).toEqual(input.sources.map(row => row.target));
    expect(formed.outcome.proposal.source_task_observation.observations[0]!.association).toBeUndefined();
    const client = await fixture.openClient();
    const handler = createMcpMemoryToolHandler({ ...createDeps(), now: () => CLOCK, recallService: new RecallService({
      ...createDependencies().dependencies, now: () => CLOCK, readSnapshot: client.readSnapshot,
      conditionalFieldPort: client.conditionalFieldPort, activeConstraintsPort: client.activeConstraintsPort }) });
    const call = async (interpretation_proposal: unknown, queryText = query) => {
      const response = await handler.call({ toolName: "soul.recall", arguments: { ...capableRecallConsumerDeclaration(),
        query: queryText, max_results: 5, scope_class: "project", dimension: null, domain_tags: null,
        result_kind_view: "source_only", interpretation_proposal }, context: { workspaceId: WS, runId: "run-1",
        sessionId: "catalog-capacity", agentTarget: "codex" } });
      if (!response.ok) throw new Error(JSON.stringify(response.error));
      return SoulMemorySearchResponseSchema.parse(response.output);
    };
    const baseline = await call({ schema_version: 1, producer_id: QUESTION_TIME_PROPOSAL_PRODUCER_ID,
      original_query_digest: digest(query), question_time: questionTime });
    expect(baseline.results.some(row => row.target.kind === "source_evidence" && row.target.root_id === useful.source.target.root_id)).toBe(false);
    const page = await call(formed.outcome.proposal), result = page.results[0]!, support = page.index!.entries[0]!.navigation!.task_observation!;
    expect(result.target).toMatchObject({ kind: "source_evidence", root_id: useful.source.target.root_id });
    expect(result.content_preview).toContain(askedReport);
    expect(support).toMatchObject({ semantic_status: "unreviewed", world_claim: "unknown", temporal_relation: "unavailable" });
    if (result.target.kind !== "source_evidence" || result.target.span === undefined) throw new Error("delivered span required");
    expect(Buffer.from(taskBody).subarray(result.target.span.content_start, result.target.span.content_end).toString("utf8")).toBe(result.content_preview);
    expect(result.target.span.content_start).toBeLessThanOrEqual(support.conditional_binding!.support_span.start_byte);
    expect(result.target.span.content_end).toBeGreaterThanOrEqual(support.conditional_binding!.support_span.end_byte);
    const raw = await call(undefined, "Repair15");
    const fallback = raw.results.find(row => row.target.kind === "source_evidence" && row.target.root_id === large.source.target.root_id)!;
    expect(fallback).toBeDefined();
    if (fallback.target.kind !== "source_evidence" || fallback.target.span === undefined) throw new Error("raw fallback span required");
    expect(Buffer.from(largeBody).subarray(fallback.target.span.content_start, fallback.target.span.content_end).toString("utf8")).toBe(fallback.content_preview);
    expect(raw.index!.entries.every(entry => entry.navigation?.task_observation === undefined)).toBe(true);
  }, { ...SIMULATED_CONFIGURATION, profile: { ...SIMULATED_CONFIGURATION.profile, max_input_tokens: 4096 } });
}, 60_000);
