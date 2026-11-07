import { join } from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary({
    descendantPreload: new URL("../../../../../bench-runner/src/__tests__/support/provider-free-cli-bootstrap.mjs", import.meta.url).href });
});
afterEach(() => { expect(isolation.violations).toEqual([]); isolation.assertSafe(true); vi.restoreAllMocks(); });
afterAll(() => isolation.restore());
import { RecallService, capableRecallConsumerDeclaration, fieldContractSha256 } from "@do-soul/alaya-core";
import { SqliteFieldEraseBarrierRepo } from "@do-soul/alaya-storage";
import { QUESTION_TIME_PROPOSAL_PRODUCER_ID, SoulMemorySearchResponseSchema, SourceSemanticResourceLedger,
  hashLabeledIdentity, sourceIndexNativeRootKey, type SourceIndexTarget, type SourceTaskObservationProposal } from "@do-soul/alaya-protocol";
import { fixture as storageFixture } from "../../../../../../packages/storage/src/__tests__/repos/source-index/source-index-fixture.js";
import { publishMessages, publishStatement } from "../../../../../../packages/storage/src/__tests__/repos/source-index/source-template-fixture.js";
import { createDependencies } from "../../../../../../packages/core/src/__tests__/recall/recall-service-test-fixtures.js";
import { preferTaskObservations, type TaskObservationInspection }
  from "../../../../../../packages/core/src/source-index/task-observation-preference.js";
import { createDeps } from "../../mcp-memory/tool/mcp-memory-tool-handler-fixture.js";
import { createMcpMemoryToolHandler } from "../../../mcp-memory/tool/tool-handler.js";
import { nominateNativeSources } from "../../../runtime/recall-read-worker/observer-operations.js";
import { interpretSourceTaskObservationSourceLocalDecoded } from "../../../../../bench-runner/src/runs/source-task-observation/formation.js";
import { CLOCK, WS, digest, withIndexedSources, SIMULATED_CONFIGURATION, type IndexFixture }
  from "./source-semantic-index-acquisition.test-support.js";

const query = "needle repair tool";
const excerpt = "I repaired the café hinge with a silver wrench.";
const userText = `${"earlier detail ".repeat(3)}${excerpt} ${"later detail ".repeat(20)}`;
const assistantText = "needle repair tool";
const body = `user: ${userText}\nassistant: ${assistantText}\n`;
const originals = Array.from({ length: 16 }, (_, index) => ({ id: `original-${index}`,
  message: index === 0 ? userText : `${query} ordinary memory ${index}.`,
  text: index === 0 ? body : `user: ${query} ordinary memory ${index}.\n`,
  eventTime: "2026-09-08T00:00:00.000Z", vector: [1, 0, 0] }));
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
  const run = (work_units: number) => {
    const meter = new SourceSemanticResourceLedger({ work_units, memory_bytes: 16_000_000 });
    const nominations = new Map(result.nominations.map(item => [sourceIndexNativeRootKey(item.source), item]));
    const observations: TaskObservationInspection[] = [];
    let nativeBytes = 0;
    preferTaskObservations({ proposal, question: questionTime, query,
      original: [[sourceIndexNativeRootKey(source), row]], nominations, occurrences: [], max_roots: 16,
      repository: fixture.repository, meter, association: { work_units: 0, memory_bytes: 0 },
      retention: { retain: (value, ledger) => { const before = ledger.spentBytes;
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
}

it("binds a raw observation outside the nominated statement and delivers it through the real Worker and MCP", async () => {
  await withIndexedSources(sources, async fixture => {
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
    const source = fixture.targets.find(row => row.source_id === "original-0" && row.auxiliary === undefined)!;
    const formed = interpretSourceTaskObservationSourceLocalDecoded({ query, interpretation_clock: CLOCK, question_time: questionTime,
      sources: [{ source_ref: "source1", target: source.target, source_observed_at: originals[0]!.eventTime, body }] },
    { rawJson: JSON.stringify({ observations: [{ source_ref: "source1", source_excerpt: excerpt, query_excerpt: query,
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
        source_observed_at: originals[0]!.eventTime, source_excerpt: observation.source_excerpt } });
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
        const messages = source.id === "original-0" ? [{ role: "user", text: source.message },
          { role: "assistant", text: assistantText }] : [{ role: "user", text: source.message }];
        const input = publishMessages(environment, messages, source.id, WS, source.eventTime, "project");
        if (source.id === "original-0") publishStatement(environment, input, "assistant-discovery", 1,
          { statement: { text: assistantText, relation: "reported event" } });
      }
    } finally { environment.database.close({ optimize: false }); }
  });
}, 30_000);
