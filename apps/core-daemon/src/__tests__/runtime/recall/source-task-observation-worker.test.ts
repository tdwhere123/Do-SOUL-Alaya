import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../../scripts/test-support/provider-free/provider-free-boundary.js");
  return installProviderFreeBoundary({
    descendantPreload: new URL("../../../../../../scripts/test-support/provider-free/provider-free-cli-bootstrap.mjs", import.meta.url).href });
});
afterEach(() => { expect(isolation.violations).toEqual([]); isolation.assertSafe(true); vi.restoreAllMocks(); });
afterAll(() => isolation.restore());
import { RecallService, capableRecallConsumerDeclaration, fieldContractSha256 } from "@do-soul/alaya-core";
import { SqliteFieldEraseBarrierRepo } from "@do-soul/alaya-storage";
import { QUESTION_TIME_PROPOSAL_PRODUCER_ID, hashLabeledIdentity, sourceSemanticCorrespondenceIdentity,
  SoulMemorySearchResponseSchema } from "@do-soul/alaya-protocol";
import { createDependencies } from "../../../../../../packages/core/src/__tests__/recall/recall-service-test-fixtures.js";
import { createDeps } from "../../mcp-memory/tool/mcp-memory-tool-handler-fixture.js";
import { createMcpMemoryToolHandler } from "../../../mcp-memory/tool/tool-handler.js";
import { interpretSourceTaskObservationSourceLocalDecoded, buildSourceTaskObservationRequest }
  from "../../../../../bench-runner/src/runs/source-task-observation/formation.js";
import { CLOCK, WS, digest, withIndexedSources, SIMULATED_CONFIGURATION } from "./source-semantic-index-acquisition.test-support.js";
import { selectedTaskSource, observationEndpointChoice } from "./source-task-observation.test-support.js";

const query = "What tool did I use to repair the hinge last Thursday?";
const repair = "I repaired the hinge with a silver wrench on September 3.";
const lamp = "I fixed the lamp with a blue wrench on September 7.";
const sourceText = `${query} ${repair} ${lamp}`;
const standing = "The repair shop offers a standing 10% discount.";
const originals = Array.from({ length: 16 }, (_, index) => ({ id: `original-${index}`,
  text: index === 0 ? sourceText : `${query} ${index === 1 ? standing : `ordinary memory ${index}.`}`,
  eventTime: "2026-09-08T00:00:00.000Z", vector: [1, 0, 0] }));
const preferred = Array.from({ length: 16 }, (_, index) => ({ id: `preferred-${index}`,
  text: `${query} dated event ${index}. ${"noise ".repeat(100)}`,
  eventTime: "2026-09-17T23:00:00.000Z", vector: [-1, 0, 0] }));
const questionTime = { interpretation_clock: CLOCK, intervals: [{ start: "2026-09-17", end: "2026-09-17" }] };
const baselineProposal = { schema_version: 1, producer_id: QUESTION_TIME_PROPOSAL_PRODUCER_ID,
  original_query_digest: digest(query), question_time: questionTime };
const noTime = { time_status: "unavailable", time_expression: null, time_anchor: null, time_start: null, time_end: null };
const wire = { source_ref: "source1", source_excerpt: `${repair} ${lamp}`, query_excerpt: query,
  utterance_kind: "reported_event", description: "A source-local repair report; applicability remains unknown.",
  task_correspondence: "possible", task_role: "task_input", task_component: "reported repair tool",
  time_status: "interpreted", time_expression: "September 3", time_anchor: "explicit_date",
  time_start: "2026-09-03", time_end: "2026-09-03" };

it("executes exact event operands before native restoration while preserving raw fallback and frozen delivery", async () => {
  await withIndexedSources([...originals, ...preferred], async fixture => {
    const selected = await selectedTaskSource(fixture, { sourceId: "original-0", body: sourceText,
      observedAt: originals[0]!.eventTime, query, selectedFrame: "repair", evidence: true, temporalSlot: "date",
      frames: [{ id: "repair", text: repair, predicate: "repaired", roles: [
        { id: "theme", text: "hinge" }, { id: "tool", text: "silver wrench" }, { id: "date", text: "September 3" }] },
      { id: "lamp", text: lamp, predicate: "fixed", roles: [{ id: "theme", text: "lamp" },
        { id: "tool", text: "blue wrench" }, { id: "date", text: "September 7" }] }],
      roles: [{ id: "theme", queryExcerpt: "hinge", named: true }, { id: "tool", queryExcerpt: "What tool" }] });
    const input = { query, interpretation_clock: CLOCK, question_time: questionTime,
      ...selected.selection, sources: [selected.source] };
    expect(JSON.parse(buildSourceTaskObservationRequest(input).userPrompt).sources[0].endpoint_catalog.associations).toHaveLength(1);
    const form = (row: object) => {
      const result = interpretSourceTaskObservationSourceLocalDecoded(input,
        { rawJson: JSON.stringify({ observations: [{ ...row, ...observationEndpointChoice(input, "source1", selected.expectedAssociation) }] }), finishReason: "stop" }, "step-3.5-2603-low-json-schema-v1");
      if (result.outcome.status !== "source_task_observation") throw new Error(JSON.stringify(result.outcome));
      return result.outcome.proposal;
    };
    const proposal = form(wire), observed = proposal.source_task_observation.observations[0]!;
    const client = await fixture.openClient();
    const service = new RecallService({ ...createDependencies().dependencies, now: () => CLOCK,
      readSnapshot: client.readSnapshot, conditionalFieldPort: client.conditionalFieldPort,
      activeConstraintsPort: client.activeConstraintsPort });
    const handler = createMcpMemoryToolHandler({ ...createDeps(), now: () => CLOCK, recallService: service });
    const call = async (interpretation_proposal: unknown, extra: object = {}) => {
      const output = await handler.call({ toolName: "soul.recall", arguments: { ...capableRecallConsumerDeclaration(),
        query, max_results: 5, scope_class: "project", dimension: null, domain_tags: null,
        result_kind_view: "source_only", interpretation_proposal, ...extra }, context: { workspaceId: WS, runId: "run-1",
        sessionId: "bound-task-observation", agentTarget: "codex" } });
      if (!output.ok) throw new Error(JSON.stringify(output.error));
      return SoulMemorySearchResponseSchema.parse(output.output);
    };
    const ids = (page: Awaited<ReturnType<typeof call>>) => page.index!.entries.map(entry =>
      entry.target.kind === "source_evidence" ? entry.target.root_id : "memory");
    const target = selected.source.target;
    const baseline = await call(baselineProposal);
    expect(ids(baseline)).not.toContain(target.root_id);
    const capture = await client.observeSourceSemantics({ max_events: 2048, max_bytes: 524288 }, () => call(proposal));
    if (capture.outcome.status !== "success") throw capture.outcome.error;
    const first = capture.outcome.value;
    expect(ids(first)[0], JSON.stringify(capture.observations.flatMap(frame => frame.events)
      .filter(event => event.kind === "source_index_acquisition").map(event => event.data))).toBe(target.root_id);
    expect(ids(first).slice(1)).toEqual(ids(baseline).slice(0, 4));
    const withObservation = (row: unknown) => ({ ...proposal,
      source_task_observation: { ...proposal.source_task_observation, observations: [row] } });
    // Only the explicit operand changes. Record clock, bytes, Q, H and C remain fixed.
    const otherEvent = { ...observed, association: { ...observed.association!,
      temporal_operand: { kind: "slot", frame: "lamp", slot: "date" } },
      event_time: { status: "interpreted", expression: "September 7", anchor: "explicit_date",
        interval: { start: "2026-09-07", end: "2026-09-07" } } };
    expect(ids(await call(withObservation(otherEvent)))).toEqual(ids(baseline));
    expect(ids(await call(withObservation({ ...otherEvent, association: observed.association })))).toEqual(ids(baseline));
    const qualification = first.index!.entries[0]!.navigation!.task_observation!;
    expect(qualification).toMatchObject({ semantic_status: "unreviewed", world_claim: "unknown",
      temporal_relation: "hypothesized_disjoint", conditional_binding: {
        source_interpretation_id: selected.source.selected_interpretation.interpretation_id,
        semantic_correspondence_id: selected.expectedAssociation.semantic_correspondence_id } });
    expect(first.results[0]!.content_preview).toContain(repair);
    const delivered = first.results[0]!.target;
    if (delivered.kind !== "source_evidence" || delivered.span === undefined) throw new Error("source span required");
    expect(Buffer.from(sourceText).subarray(delivered.span.content_start, delivered.span.content_end).toString("utf8"))
      .toBe(first.results[0]!.content_preview);
    expect(delivered.span.content_start).toBeLessThanOrEqual(qualification.conditional_binding!.support_span.start_byte);
    expect(delivered.span.content_end).toBeGreaterThanOrEqual(qualification.conditional_binding!.support_span.end_byte);

    const c = selected.selection.semantic_correspondences[0]!;
    const unresolved = { ...c, correspondences: c.correspondences.filter(row => row.query_endpoint.kind !== "referent") };
    const unresolvedProposal = { ...proposal, source_task_observation: { ...proposal.source_task_observation,
      semantic_correspondences: [unresolved], observations: [{ ...observed, association: { ...observed.association!,
        semantic_correspondence_id: sourceSemanticCorrespondenceIdentity(unresolved, fieldContractSha256) } }] } };
    expect(ids(await call(unresolvedProposal))).toEqual(ids(baseline));
    for (const unbound of [
      { ...proposal.source_task_observation, query_semantics: undefined },
      { ...proposal.source_task_observation, semantic_correspondences: [] },
      { ...proposal.source_task_observation, observations: [{ ...observed, association: undefined }] },
      { status: "failed", reason: "not_executed" }, { status: "ready", observations: "malformed" }
    ]) expect(ids(await call({ ...proposal, source_task_observation: unbound }))).toEqual(ids(baseline));
    for (const row of [
      { ...observed, source: { ...target, source_version: "stale" } },
      { ...observed, source: { ...target, content_digest: digest("other bytes") } },
      { ...observed, source_observed_at: CLOCK },
      { ...observed, source_excerpt: { ...observed.source_excerpt, text: "altered bytes" } }
    ]) expect(ids(await call(withObservation(row)))).toEqual(ids(baseline));
    // Descriptive text has no execution authority once endpoints are selected.
    const relabeled = await call(withObservation({ ...observed,
      task_correspondence: { status: "possible", role: "task_input", component: "irrelevant wording" } }));
    expect(ids(relabeled)).toEqual(ids(first));
    const unknownTime = await call(form({ ...wire, ...noTime }));
    expect(ids(unknownTime)).toEqual(ids(first));
    expect(unknownTime.index!.entries[0]!.navigation!.task_observation).toMatchObject({ temporal_relation: "unavailable",
      world_claim: "unknown", observation: { association: { target: { kind: "evidence", input: 0 } } } });
    for (const hard of [{ since: "2026-09-17T00:00:00.000Z" }, { until: "2026-09-07T23:59:59.999Z" }]) {
      expect(ids(await call(proposal, hard))).toEqual(ids(await call(baselineProposal, hard)));
    }
    expect(ids(await call(proposal, { scope_class: "global_core" }))).toEqual([]);
    expect(first.index!.continuation).not.toBeNull();
    const next = await call(proposal, { continuation: first.index!.continuation });
    expect((await call(proposal, { continuation: first.index!.continuation })).results).toEqual(next.results);
    expect(ids(next)).not.toContain(target.root_id);
    const found = [...ids(first), ...ids(next)];
    let continuation = next.index!.continuation;
    for (let page = 0; continuation !== null && page < 8; page++) {
      const nextPage = await call(proposal, { continuation }); found.push(...ids(nextPage)); continuation = nextPage.index!.continuation;
    }
    expect(continuation).toBeNull(); expect(new Set(found).size).toBe(16);
    expect(ids(await call(undefined, { query: "silver wrench" }))).toContain(target.root_id);
    await selected.withdraw();
    const withdrawn = await call(proposal);
    expect(ids(withdrawn)).toEqual(ids(baseline));
    expect(withdrawn.index!.entries.every(entry => entry.navigation?.task_observation === undefined)).toBe(true);
    expect(ids(await call(undefined, { query: "silver wrench" }))).toContain(target.root_id);
    expect((await call(proposal, { continuation: first.index!.continuation })).index!.completeness.logical_index).toBe("invalidated");
    const eraser = new SqliteFieldEraseBarrierRepo(fixture.database, fieldContractSha256);
    eraser.apply({ identity: hashLabeledIdentity("erase_barrier", [WS, "source_record", target.root_id, ""], fieldContractSha256),
      barrier_id: "erase-bound-task-source", workspace_id: WS, generation_id: null,
      subject_kind: "source_record", subject_id: target.root_id, erased_at: CLOCK });
    const stale = await call(proposal, { continuation: first.index!.continuation });
    expect(stale.index!.completeness.logical_index).toBe("invalidated");
    expect(ids(await call(proposal))).not.toContain(target.root_id);
  }, { ...SIMULATED_CONFIGURATION, profile: { ...SIMULATED_CONFIGURATION.profile, max_input_tokens: 4096 } });
}, 60_000);

it("admits a standing input without occurrence-time support and keeps malformed partial formation explicit", async () => {
  const taskQuery = "What discount did the repair shop offer for the hinge last Thursday?";
  await withIndexedSources([...originals, ...preferred], async fixture => {
    const selected = await selectedTaskSource(fixture, { sourceId: "original-1", body: originals[1]!.text,
      observedAt: originals[1]!.eventTime, query: taskQuery, selectedFrame: "offer", evidence: true,
      frames: [{ id: "offer", text: standing, predicate: "offers", roles: [{ id: "discount", text: "10%" }] }],
      roles: [{ id: "discount", queryExcerpt: "What discount" }] });
    const input = { query: taskQuery, interpretation_clock: CLOCK, question_time: questionTime, ...selected.selection,
      sources: [selected.source, { source_ref: "source2", target: fixture.targets.find(row => row.source_id === "original-0")!.target,
        source_observed_at: originals[0]!.eventTime, body: sourceText }] };
    const row = { ...wire, ...noTime, ...observationEndpointChoice(input, "source1", selected.expectedAssociation), source_excerpt: standing, query_excerpt: taskQuery, utterance_kind: "standing" };
    const formation = interpretSourceTaskObservationSourceLocalDecoded(input, { rawJson: JSON.stringify({ observations: [row,
      { ...wire, source_ref: "source2", query_excerpt: taskQuery, time_start: "not-a-calendar-date" }] }), finishReason: "stop" },
    "step-3.5-2603-low-json-schema-v1");
    expect(formation).toMatchObject({ classified: "incomplete", admitted: true,
      outcome: { proposal: { source_task_observation: { status: "partial" } }, diagnostics: [{ reason: "invalid_shape" }] } });
    if (formation.outcome.status !== "source_task_observation") throw new Error("partial observation expected");
    const client = await fixture.openClient();
    const handler = createMcpMemoryToolHandler({ ...createDeps(), now: () => CLOCK, recallService: new RecallService({
      ...createDependencies().dependencies, now: () => CLOCK, readSnapshot: client.readSnapshot,
      conditionalFieldPort: client.conditionalFieldPort, activeConstraintsPort: client.activeConstraintsPort }) });
    const call = async (proposal: unknown) => {
      const result = await handler.call({ toolName: "soul.recall", arguments: { ...capableRecallConsumerDeclaration(),
        query: taskQuery, max_results: 5, scope_class: "project", dimension: null, domain_tags: null,
        result_kind_view: "source_only", interpretation_proposal: proposal }, context: { workspaceId: WS, runId: "run-1",
        sessionId: "standing-task-input", agentTarget: "codex" } });
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      return SoulMemorySearchResponseSchema.parse(result.output);
    };
    const baseline = await call({ ...baselineProposal, original_query_digest: digest(taskQuery) });
    expect(baseline.index!.entries.every(entry => entry.target.kind !== "source_evidence"
      || entry.target.root_id !== selected.source.target.root_id)).toBe(true);
    const page = await call(formation.outcome.proposal);
    expect(page.index!.entries[0]!.target).toMatchObject({ root_id: selected.source.target.root_id });
    expect(page.index!.entries[0]!.navigation!.task_observation).toMatchObject({ temporal_relation: "unavailable",
      world_claim: "unknown", observation: { utterance: { kind: "standing" }, association: { target: { kind: "evidence" } } } });
    expect(page.results[0]!.content_preview).toContain(standing);
    await fixture.admit({ id: "original-1", text: "A replacement discount record.", eventTime: CLOCK }, "2");
    const replaced = await call(formation.outcome.proposal);
    expect(replaced.index!.entries.every(entry => entry.target.kind !== "source_evidence"
      || entry.target.root_id !== selected.source.target.root_id)).toBe(true);
  }, { ...SIMULATED_CONFIGURATION, profile: { ...SIMULATED_CONFIGURATION.profile, max_input_tokens: 4096 } });
}, 60_000);
