import { join } from "node:path";
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
  admitSourceSemanticCorrespondence,
  SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID
} from "@do-soul/alaya-core";
import { SqliteFieldEraseBarrierRepo } from "@do-soul/alaya-storage";
import {
  QUESTION_TIME_PROPOSAL_PRODUCER_ID,
  hashLabeledIdentity,
  sourceSemanticCorrespondenceIdentity,
  SoulMemorySearchResponseSchema,
  SourceSemanticResourceLedger,
  SourceSemanticResourceExhausted,
  sourceIndexNativeRootKey,
  type SourceIndexTarget,
  type SourceTaskObservationProposal,
  SourceSemanticCorrespondenceSchema,
  sourceSemanticQueryIdentity,
  SourceTaskObservationFormationInputSchema
} from "@do-soul/alaya-protocol";
import { createDependencies } from "../../../../../../packages/core/src/__tests__/recall/recall-service-test-fixtures.js";
import { createDeps } from "../../mcp-memory/tool/mcp-memory-tool-handler-fixture.js";
import { createMcpMemoryToolHandler } from "../../../mcp-memory/tool/tool-handler.js";
import { interpretSourceTaskObservationSourceLocalDecoded, buildSourceTaskObservationRequest } from "../../../../../bench-runner/src/runs/source-task-observation/formation.js";
import { CLOCK, WS, digest, withIndexedSources, SIMULATED_CONFIGURATION, type IndexFixture } from "./source-semantic-index-acquisition.test-support.js";
import { selectedTaskSource, observationEndpointChoice, publishAuthoredTaskSource } from "./source-task-observation.test-support.js";
import { fixture as storageFixture } from "../../../../../../packages/storage/src/__tests__/repos/source-index/source-index-fixture.js";
import { publishMessages, publishStatement } from "../../../../../../packages/storage/src/__tests__/repos/source-index/source-template-fixture.js";
import { preferTaskObservations, type TaskObservationInspection } from "../../../../../../packages/core/src/source-index/task-observation-preference.js";
import { nominateNativeSources } from "../../../runtime/recall-read-worker/observer-operations.js";
import { taskInterpretationReader } from "../../../runtime/recall-read-worker/source-semantic-discovery.js";
import { publishWireTaskSource, taskQuery as query, taskBody, askedReport, questionTime, recorded } from "./source-task-observation-wire.test-support.js";


describe("source-task observation worker", () => {
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
    expect(ids(first).slice(1, ids(baseline).length)).toEqual(ids(baseline).slice(1));
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
    // Displaced slot-0 incumbent stays in the 16-root pool after task promotion and agreed-head swap.
    expect(found).toContain(ids(baseline)[0]);
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
});

describe("source-task observation auxiliary worker", () => {
const query = "needle repair tool";
const excerpt = "I repaired the café hinge with a silver wrench.";
const userText = `${"earlier detail ".repeat(3)}${excerpt} ${"later detail ".repeat(20)}`;
const assistantText = "needle repair tool";
const body = `user: ${userText}\nassistant: ${assistantText}\n`;
const originals = Array.from({ length: 16 }, (_, index) => ({ id: `original-${index}`,
  message: index === 15 ? userText : index < 5 ? `${`${query} `.repeat(4)}ordinary memory ${index}.` : `${query} ordinary memory ${index}.`,
  text: index === 15 ? body : index < 5 ? `user: ${`${query} `.repeat(4)}ordinary memory ${index}.\n` : `user: ${query} ordinary memory ${index}.\n`,
  eventTime: "2026-09-08T00:00:00.000Z", vector: index === 15 ? [-1, 0, 0] : [1, 0, 0] }));
const preferred = Array.from({ length: 16 }, (_, index) => ({ id: `preferred-${index}`,
  message: `${query} dated event ${index}. ${"noise ".repeat(100)}`,
  text: `user: ${query} dated event ${index}. ${"noise ".repeat(100)}\n`,
  eventTime: "2026-09-17T23:00:00.000Z", vector: [-1, 0, 0] }));
const sources = [...originals, ...preferred];
const questionTime = { interpretation_clock: CLOCK, intervals: [{ start: "2026-09-17", end: "2026-09-17" }] };
const baselineProposal = { schema_version: 1, producer_id: QUESTION_TIME_PROPOSAL_PRODUCER_ID,
  original_query_digest: digest(query), question_time: questionTime };

async function checkBudgetFallback(fixture: IndexFixture, source: SourceIndexTarget,
  proposal: Extract<SourceTaskObservationProposal, { observations: unknown }>) {
  const prepared = await fixture.prepareQuery({ navigation: query, signal: new AbortController().signal, remainingMs: () => 60_000 });
  const capture = fixture.database.connection.transaction(() => nominateNativeSources(fixture.database, {
    workspaceId: WS, query, authorizedScopes: ["project"], questionTime, budget: { work_units: 0, memory_bytes: 0 }
  }, prepared.vector))();
  const result = capture.result;
  if (result === null) throw new Error("expected the paid incumbent");
  expect(result.nominations).toHaveLength(16);
  expect(result.nominations.some(row => row.source.target.root_id === source.target.root_id)).toBe(false);
  const row = { source, lexical: [], vector: null };
  const admission = fixture.repository.admitQueryCandidate(source, null, { work_units: 2_000_000, memory_bytes: 16_000_000 });
  expect(admission.status).toBe("ready");
  const nativeRead = fixture.repository.readTaskObservation.bind(fixture.repository);
  const reads: { budget: { work_units: number; memory_bytes: number }; result: ReturnType<typeof nativeRead> }[] = [];
  vi.spyOn(fixture.repository, "readTaskObservation").mockImplementation((candidate, span, budget) => {
    const read = nativeRead(candidate, span, budget); reads.push({ budget, result: read }); return read;
  });
  const semanticStarts: number[] = [];
  const readInterpretation = taskInterpretationReader(fixture.database, WS, ["project"]);
  const run = (work_units: number, refuseReplacement = false) => {
    const meter = new SourceSemanticResourceLedger({ work_units, memory_bytes: 16_000_000 });
    const nominations = new Map(result.nominations.map(item => [sourceIndexNativeRootKey(item.source), item]));
    const observations: TaskObservationInspection[] = [];
    let nativeBytes = 0;
    preferTaskObservations({ proposal, question: questionTime, query,
      original: [[sourceIndexNativeRootKey(source), row]], nominations, occurrences: [], max_roots: 16,
      repository: fixture.repository, meter, association: { work_units: 0, memory_bytes: 0 },
      retention: { readInterpretation: (identity, ledger, nativeBytes) => {
        const selected = readInterpretation(identity, ledger, nativeBytes);
        const admission = SourceSemanticResourceLedger.measureRetain([selected.bound.interpretation,
          proposal.query_semantics, proposal.semantic_correspondences![0]], ledger.remaining());
        semanticStarts.push(work_units - ledger.work + admission.work_units);
        return selected;
      }, retain: (value, ledger) => { const before = ledger.spentBytes;
        if (refuseReplacement && value.task_observations !== undefined) {
          ledger.charge(11, 123, "fixture partial replacement");
          throw new SourceSemanticResourceExhausted("replacement refused");
        }
        ledger.retain(value, "fixture incumbent retention"); return ledger.spentBytes - before; } },
      result: () => result, nativeBytes: bytes => { nativeBytes += bytes; }, observe: observation => observations.push(observation) });
    return { meter, nominations: [...nominations.values()], observations, nativeBytes };
  };
  const funded = run(2_000_000), probe = reads[0]!;
  expect(probe.result.status).toBe("ready");
  expect(funded.nominations[0]!.source).toEqual(source);
  const bytes = proposal.observations[0]!.source_excerpt.end_byte - proposal.observations[0]!.source_excerpt.start_byte;
  const beforeNativeRead = 2_000_000 - probe.budget.work_units;
  const limited = run(beforeNativeRead + admission.resources.work + bytes + 4), refused = reads[1]!;
  expect(refused.result).toMatchObject({ status: "unknown", reason: "source_task_read_budget:source task excerpt" });
  expect(refused.result.resources).toEqual(admission.resources);
  expect(limited.nominations).toEqual(result.nominations);
  expect(limited.nativeBytes).toBe(admission.resources.native_bytes);
  expect(limited.nativeBytes).toBeGreaterThan(0);
  expect(limited.meter.spentWork).toBe(beforeNativeRead + admission.resources.work);
  expect(limited.meter.spentBytes).toBe(16_000_000 - refused.budget.memory_bytes + admission.resources.memory_bytes);
  expect(limited.observations).toContainEqual(expect.objectContaining({ status: "unknown",
    reason: "source_task_read_budget:source task excerpt" }));
  const computationRefused = run(semanticStarts[0]! + 1);
  expect(computationRefused.nominations).toEqual(result.nominations);
  expect(computationRefused.nativeBytes).toBe(funded.nativeBytes);
  expect(computationRefused.observations).toContainEqual(expect.objectContaining({ status: "unknown",
    reason: "source_task_computation_incomplete" }));
  const retentionRefused = run(2_000_000, true);
  expect(retentionRefused.nominations).toEqual(result.nominations);
  expect(retentionRefused.nativeBytes).toBe(funded.nativeBytes);
  expect(retentionRefused.meter.spentWork).toBeGreaterThan(limited.meter.spentWork + 11);
  expect(retentionRefused.observations).toContainEqual(expect.objectContaining({ status: "unknown", reason: "replacement refused" }));
}

it("binds a raw observation outside the nominated statement and delivers it through the real Worker and MCP", async () => {
  await withIndexedSources(sources, async fixture => {
    const selected = await selectedTaskSource(fixture, { sourceId: "original-15", body, observedAt: originals[15]!.eventTime,
      query, selectedFrame: "repair", evidence: true,
      frames: [{ id: "repair", text: excerpt, predicate: "repaired", roles: [{ id: "tool", text: "silver wrench" }] }],
      roles: [{ id: "tool", queryExcerpt: "tool" }] });
    const client = await fixture.openClient();
    const service = new RecallService({ ...createDependencies().dependencies,
      now: () => CLOCK, readSnapshot: client.readSnapshot, conditionalFieldPort: client.conditionalFieldPort,
      activeConstraintsPort: client.activeConstraintsPort });
    const handler = createMcpMemoryToolHandler({ ...createDeps(), now: () => CLOCK, recallService: service });
    const call = async (interpretation_proposal: unknown, extra: object = {}) => {
      const output = await handler.call({ toolName: "soul.recall", arguments: { ...capableRecallConsumerDeclaration(),
        query, max_results: 5, scope_class: "project", dimension: null, domain_tags: null,
        result_kind_view: "source_only", interpretation_proposal, ...extra }, context: { workspaceId: WS, runId: "run-1",
        sessionId: "auxiliary-task-observation", agentTarget: "codex" } });
      if (!output.ok) throw new Error(JSON.stringify(output.error));
      return SoulMemorySearchResponseSchema.parse(output.output);
    };
    const source = fixture.targets.find(row => row.source_id === "original-15" && row.auxiliary === undefined)!;
    const input = { query, interpretation_clock: CLOCK, question_time: questionTime, ...selected.selection, sources: [selected.source] };
    const formed = interpretSourceTaskObservationSourceLocalDecoded(input,
    { rawJson: JSON.stringify({ observations: [{ source_ref: "source1", source_excerpt: excerpt, query_excerpt: query,
      ...observationEndpointChoice(input, "source1", selected.expectedAssociation),
      utterance_kind: "reported_event", description: "The speaker reports using a wrench.", task_correspondence: "possible",
      task_role: "requested_event", task_component: "repair tool", time_status: "unavailable", time_expression: null,
      time_anchor: null, time_start: null, time_end: null }] }), finishReason: "stop" }, "step-3.5-2603-low-json-schema-v1");
    expect(formed).toMatchObject({ classified: "interpreted", admitted: true, outcome: { status: "source_task_observation" } });
    if (formed.outcome.status !== "source_task_observation") throw new Error("expected the synthetic observation proposal");
    const proposal = formed.outcome.proposal;
    const observation = proposal.source_task_observation.observations[0]!;
    expect(observation.source_excerpt).toEqual({ start_byte: 51, end_byte: 99, text: excerpt });
    const ids = (page: Awaited<ReturnType<typeof call>>) => page.index!.entries.map(entry =>
      entry.target.kind === "source_evidence" ? entry.target.root_id : "memory");
    const baseline = await call(baselineProposal);
    expect(ids(baseline)).not.toContain(source.target.root_id);
    const observed = await client.observeSourceSemantics({ max_events: 2048, max_bytes: 524288 }, () => call(proposal));
    expect(observed.outcome.status).toBe("success");
    if (observed.outcome.status !== "success") throw observed.outcome.error;
    const delivered = observed.outcome.value;
    const events = observed.observations.flatMap(frame => frame.events).filter(event => event.kind === "source_index_acquisition");
    const inventory = events.map(event => event.data).find(data => (data as { kind?: string }).kind === "source_task_inventory") as
      { state: string; original: readonly SourceIndexTarget[]; eligible: readonly SourceIndexTarget[] } | undefined;
    expect(inventory?.state).toBe("active");
    const nominated = inventory?.original.find(row => row.target.root_id === source.target.root_id);
    expect(nominated?.auxiliary).toBeDefined();
    expect(inventory?.eligible.find(row => row.target.root_id === source.target.root_id)).toEqual(nominated);
    expect(observation.source_excerpt.start_byte).toBeGreaterThan(nominated!.body_bytes);
    expect(nominated!.auxiliary!.source_span).toEqual([372, 390]);
    expect(observation.source_excerpt.end_byte).toBeLessThan(nominated!.auxiliary!.source_span[0]);
    expect(events.map(event => event.data)).toContainEqual(expect.objectContaining({ kind: "source_task_observation",
      observation: expect.objectContaining({ status: "applied", observed: 1, preferred: 1 }) }));
    expect(ids(delivered)[0]).toBe(source.target.root_id);
    expect(ids(delivered).slice(1)).toEqual(ids(baseline).slice(0, 4));
    expect(delivered.index!.entries[0]!.navigation?.task_observation).toMatchObject({ semantic_status: "unreviewed",
      world_claim: "unknown", temporal_relation: "unavailable", observation: { source: source.target,
        source_observed_at: originals[15]!.eventTime, source_excerpt: observation.source_excerpt } });
    const visible = delivered.results[0]!;
    expect(delivered.index!.entries[0]!.navigation?.location).toEqual({
      start_byte: nominated!.auxiliary!.source_span[0], end_byte: nominated!.auxiliary!.source_span[1] });
    expect(delivered.index!.entries[0]!.target).toEqual(visible.target);
    expect(visible.content_preview).toContain(excerpt);
    expect(visible.target.kind).toBe("source_evidence");
    if (visible.target.kind !== "source_evidence" || visible.target.span === undefined) throw new Error("missing delivered source span");
    expect(visible.target.span.content_start).toBeLessThanOrEqual(observation.source_excerpt.start_byte);
    expect(visible.target.span.content_end).toBeGreaterThanOrEqual(observation.source_excerpt.end_byte);
    expect(Buffer.from(body).subarray(visible.target.span.content_start, visible.target.span.content_end).toString("utf8"))
      .toBe(visible.content_preview);

    const split = observation.source_excerpt.start_byte + Buffer.byteLength("I repaired the caf") + 1;
    const outside = Buffer.byteLength(body) + 1;
    const invalidCases = [
      { row: { ...observation, source_excerpt: { start_byte: split, end_byte: split + 2, text: "xx" } }, reason: "source_task_incomplete" },
      { row: { ...observation, source_excerpt: { start_byte: outside, end_byte: outside + 2, text: "xx" } }, reason: "source_task_incomplete" },
      { row: { ...observation, source_observed_at: "2026-09-09T00:00:00.000Z" }, reason: "source_excerpt_or_clock_mismatch" }
    ];
    for (const invalid of invalidCases) {
      const checked = await client.observeSourceSemantics({ max_events: 2048, max_bytes: 524288 }, () => call({ ...proposal,
        source_task_observation: { ...proposal.source_task_observation, observations: [invalid.row] } }));
      expect(checked.outcome.status).toBe("success");
      if (checked.outcome.status !== "success") throw checked.outcome.error;
      expect(ids(checked.outcome.value)).toEqual(ids(baseline));
      expect(checked.outcome.value.index!.entries.every(entry => entry.navigation?.task_observation === undefined)).toBe(true);
      expect(checked.observations.flatMap(frame => frame.events).map(event => event.data)).toContainEqual(
        expect.objectContaining({ kind: "source_task_observation", observation: expect.objectContaining({ reason: invalid.reason }) }));
    }
    expect(ids(await call(proposal, { scope_class: "global_core" }))).toEqual([]);
    await checkBudgetFallback(fixture, nominated!, proposal.source_task_observation);
    const eraser = new SqliteFieldEraseBarrierRepo(fixture.database, fieldContractSha256);
    eraser.apply({ identity: hashLabeledIdentity("erase_barrier", [WS, "source_record", source.target.root_id, ""], fieldContractSha256),
      barrier_id: "erase-auxiliary-task-fixture", workspace_id: WS, generation_id: null,
      subject_kind: "source_record", subject_id: source.target.root_id, erased_at: CLOCK });
    const erased = await call(proposal);
    expect(ids(erased)).not.toContain(source.target.root_id);
    expect(erased.index!.entries.every(entry => entry.navigation?.task_observation?.observation.source.root_id !== source.target.root_id)).toBe(true);
  }, { ...SIMULATED_CONFIGURATION, profile: { ...SIMULATED_CONFIGURATION.profile, max_input_tokens: 4096 } }, async directory => {
    const environment = storageFixture(join(directory, "alaya.db"));
    try {
      for (const source of sources) {
        const messages = source.id === "original-15" ? [{ role: "user", text: source.message },
          { role: "assistant", text: assistantText }] : [{ role: "user", text: source.message }];
        const input = publishMessages(environment, messages, source.id, WS, source.eventTime, "project");
        if (source.id === "original-15") publishStatement(environment, input, "assistant-discovery", 1,
          { statement: { text: assistantText, relation: "reported event" } });
      }
    } finally { environment.database.close({ optimize: false }); }
  });
}, 30_000);
});

describe("source-task observation catalog capacity", () => {
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
});
