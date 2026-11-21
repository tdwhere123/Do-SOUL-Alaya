import { join } from "node:path";
import {
  afterAll,
  afterEach,
  describe,
  expect,
  it,
  vi
} from "vitest";
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
  SourceTaskObservationFormationInputSchema,
  SourceSemanticQuerySchema,
  type SourceTaskAssociation
} from "@do-soul/alaya-protocol";
import { createDependencies } from "../../../../../../packages/core/src/__tests__/recall/recall-service-test-fixtures.js";
import { createDeps } from "../../mcp-memory/tool/mcp-memory-tool-handler-fixture.js";
import { createMcpMemoryToolHandler } from "../../../mcp-memory/tool/tool-handler.js";
import { interpretSourceTaskObservationSourceLocalDecoded, buildSourceTaskObservationRequest } from "../../../../../bench-runner/src/runs/source-task-observation/formation.js";
import {
  CLOCK,
  WS,
  digest,
  withIndexedSources,
  SIMULATED_CONFIGURATION,
  type IndexFixture,
  publicMcp
} from "./source-semantic-index-acquisition.test-support.js";
import {
  selectedTaskSource,
  observationEndpointChoice,
  publishAuthoredTaskSource
} from "./source-task-observation.test-support.js";
import { fixture as storageFixture } from "../../../../../../packages/storage/src/__tests__/repos/source-index/source-index-fixture.js";
import { publishMessages, publishStatement } from "../../../../../../packages/storage/src/__tests__/repos/source-index/source-template-fixture.js";
import { preferTaskObservations, type TaskObservationInspection } from "../../../../../../packages/core/src/source-index/task-observation-preference.js";
import { nominateNativeSources } from "../../../runtime/recall-read-worker/observer-operations.js";
import { taskInterpretationReader } from "../../../runtime/recall-read-worker/source-semantic-discovery.js";
import {
  publishWireTaskSource,
  taskQuery as query,
  taskBody,
  askedReport,
  questionTime,
  recorded,
  otherReport
} from "./source-task-observation-wire.test-support.js";
import { sourceSemanticProofDependencies } from "../../../../../../packages/core/src/recall/runtime/source-semantic-delivery.js";
import { sourceSemanticSupportExtent } from "../../../../../../packages/core/src/memory/evidence-create/source-semantic-support-window.js";
import { receiveAuthoredCorrespondence } from "./source-semantic-producer-fixture.js";


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

