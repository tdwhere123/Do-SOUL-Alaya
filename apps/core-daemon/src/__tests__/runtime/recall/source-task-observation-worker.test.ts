import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); vi.restoreAllMocks(); });
afterAll(() => isolation.restore());
import { RecallService, capableRecallConsumerDeclaration, fieldContractSha256 } from "@do-soul/alaya-core";
import { SqliteFieldEraseBarrierRepo } from "@do-soul/alaya-storage";
import { SOURCE_TASK_OBSERVATION_PRODUCER_ID, QUESTION_TIME_PROPOSAL_PRODUCER_ID, hashLabeledIdentity,
  SoulMemorySearchResponseSchema, type SourceEvidenceTarget } from "@do-soul/alaya-protocol";
import { createDependencies } from "../../../../../../packages/core/src/__tests__/recall/recall-service-test-fixtures.js";
import { createDeps } from "../../mcp-memory/tool/mcp-memory-tool-handler-fixture.js";
import { createMcpMemoryToolHandler } from "../../../mcp-memory/tool/tool-handler.js";
import { interpretSourceTaskObservationDecoded } from "../../../../../bench-runner/src/runs/source-task-observation/formation.js";
import { CLOCK, WS, digest, withIndexedSources, SIMULATED_CONFIGURATION } from "./source-semantic-index-acquisition.test-support.js";

const query = "What tool did I use to repair the hinge last Thursday?";
const prefix = `${query} `;
const sourceEvent = "I repaired the hinge with a silver wrench last Thursday.";
const sourceText = prefix + sourceEvent;
const standingText = `${prefix}The repair shop offers a standing 10% discount.`;
const preferredEvent = "I repaired the hinge with a blue wrench last Thursday.";
const preferredText = prefix + preferredEvent;
const originals = Array.from({ length: 16 }, (_, index) => ({ id: `original-${index}`,
  text: index === 0 ? sourceText : index === 1 ? standingText : `${prefix}ordinary memory ${index}.`,
  eventTime: "2026-09-08T00:00:00.000Z", vector: [1, 0, 0] }));
const preferred = Array.from({ length: 16 }, (_, index) => ({ id: `preferred-${index}`,
  text: index === 0 ? `${preferredText} ${"noise ".repeat(100)}` : `${prefix}dated event ${index}. ${"noise ".repeat(100)}`,
  eventTime: "2026-09-17T23:00:00.000Z", vector: [-1, 0, 0] }));
const questionTime = { interpretation_clock: CLOCK, intervals: [{ start: "2026-09-17", end: "2026-09-17" }] };
const base = { schema_version: 1, producer_id: QUESTION_TIME_PROPOSAL_PRODUCER_ID,
  original_query_digest: digest(query), question_time: questionTime };

function proposal(target: SourceEvidenceTarget) {
  const input = { query, interpretation_clock: CLOCK, question_time: questionTime,
    sources: [{ source_ref: "source1", target, source_observed_at: originals[0]!.eventTime, body: sourceText }] };
  const rawJson = JSON.stringify({ status: "ready", observations: [{ source_ref: "source1",
    source_excerpt: sourceEvent, query_excerpt: query, utterance_kind: "reported_event",
    description: "The speaker reports repairing a hinge with a wrench.", task_correspondence: "possible",
    task_role: "requested_event", task_component: "tool used for the hinge repair", time_status: "interpreted",
    time_expression: "last Thursday", time_anchor: "source_observation_clock", time_start: "2026-09-03", time_end: "2026-09-03" }] });
  const formed = interpretSourceTaskObservationDecoded(input, { rawJson, finishReason: "stop" }, "step-3.5-2603-low-json-schema-v1");
  if (formed.outcome.status !== "source_task_observation") throw new Error(JSON.stringify(formed.outcome));
  return formed.outcome.proposal;
}

it("restores a separately timed task observation before freeze and delivers it through real SQLite and Worker", async () => {
  await withIndexedSources([...originals, ...preferred], async fixture => {
    let client = await fixture.openClient();
    const makeHandler = () => {
      const service = new RecallService({ ...createDependencies().dependencies,
        now: () => CLOCK, readSnapshot: client.readSnapshot, conditionalFieldPort: client.conditionalFieldPort,
        activeConstraintsPort: client.activeConstraintsPort });
      return createMcpMemoryToolHandler({ ...createDeps(), now: () => CLOCK, recallService: service });
    };
    let handler = makeHandler();
    const resetWorker = async () => { await client.close(); client = await fixture.openClient(); handler = makeHandler(); };
    const call = async (interpretation_proposal: unknown, extra: object = {}) => {
      const output = await handler.call({ toolName: "soul.recall", arguments: { ...capableRecallConsumerDeclaration(),
        query, max_results: 5, scope_class: "project", dimension: null, domain_tags: null,
        result_kind_view: "source_only", interpretation_proposal, ...extra }, context: { workspaceId: WS, runId: "run-1",
        sessionId: "source-task-session", agentTarget: "codex" } });
      if (!output.ok) throw new Error(JSON.stringify(output.error));
      return SoulMemorySearchResponseSchema.parse(output.output);
    };
    const target = fixture.targets.find(row => row.source_id === "original-0")!.target;
    const candidate = proposal(target), baseline = await call(base), first = await call(candidate);
    const ids = (result: typeof first) => result.index!.entries.map(entry =>
      entry.target.kind === "source_evidence" ? entry.target.root_id : "memory");
    expect(ids(baseline)).not.toContain(target.root_id);
    expect(ids(first)[0]).toBe(target.root_id);
    expect(first.index!.result_version).toBe("ordinary-native-field.v12");
    for (const result_version of ["ordinary-native-field.v10", "ordinary-native-field.v11"]) {
      const outdated = await call(candidate, { continuation: { ...first.index!.continuation!, result_version } });
      expect(outdated.index?.completeness).toMatchObject({ logical_index: "invalidated", observed_coverage: "invalidated" });
    }
    expect(first.index!.entries[0]!.navigation?.task_observation).toMatchObject({ semantic_status: "unreviewed",
      world_claim: "unknown", temporal_relation: "hypothesized_disjoint", observation: { source: target } });
    expect(first.results[0]).toBeDefined();
    expect(first.index!.continuation).not.toBeNull();
    const resume = { continuation: first.index!.continuation };
    const next = await call(candidate, resume), replay = await call(candidate, resume);
    expect(replay.results).toEqual(next.results);
    expect(replay.index!.entries).toEqual(next.index!.entries);
    const allIds = async (result: typeof first, input: unknown) => {
      const found = ids(result); let continuation = result.index!.continuation;
      for (let page = 0; continuation !== null && page < 8; page++) {
        const next = await call(input, { continuation }); found.push(...ids(next)); continuation = next.index!.continuation;
      }
      expect(continuation).toBeNull(); return found;
    };
    expect(await allIds(baseline, base)).not.toContain(target.root_id);
    const admitted = await allIds(first, candidate);
    expect(admitted).toHaveLength(16); expect(admitted).toContain(target.root_id);

    const laterTarget = fixture.targets.find(row => row.source_id === "preferred-0")!.target;
    const old = candidate.source_task_observation.observations[0]!;
    const later = { ...old, source: laterTarget, source_observed_at: preferred[0]!.eventTime,
      source_excerpt: { start_byte: Buffer.byteLength(prefix), end_byte: Buffer.byteLength(preferredText), text: preferredEvent },
      utterance: { kind: "reported_event", description: "The speaker reports a different hinge repair." },
      event_time: { ...old.event_time, interval: { start: "2026-09-17", end: "2026-09-17" } } };
    const both = { ...candidate, source_task_observation: { ...candidate.source_task_observation, observations: [old, later] } };
    const unknownTime = { ...both, source_task_observation: { ...both.source_task_observation,
      observations: [old, { ...later, event_time: { status: "unavailable" } }] } };
    const overlapPage = await call(both), unknownPage = await call(unknownTime);
    expect(ids(overlapPage).slice(0, 2)).toEqual([laterTarget.root_id, target.root_id]);
    expect(ids(unknownPage).slice(0, 2)).toEqual([target.root_id, laterTarget.root_id]);
    expect(overlapPage.index!.entries[0]!.navigation?.task_observation?.temporal_relation).toBe("hypothesized_overlap");
    expect(unknownPage.index!.entries[1]!.navigation?.task_observation?.temporal_relation).toBe("unavailable");
    expect(new Set(await allIds(overlapPage, both))).toEqual(new Set(await allIds(unknownPage, unknownTime)));

    await resetWorker();
    const standingTarget = fixture.targets.find(row => row.source_id === "original-1")!.target;
    const standingQuery = "What discount did the repair shop offer for the hinge last Thursday?";
    const standingBase = { ...base, original_query_digest: digest(standingQuery) };
    const standingObservation = { ...old, source: standingTarget, source_observed_at: originals[1]!.eventTime,
      source_excerpt: { start_byte: 0, end_byte: Buffer.byteLength(standingText), text: standingText },
      query_excerpt: { start_byte: 0, end_byte: Buffer.byteLength(standingQuery), text: standingQuery },
      utterance: { kind: "standing", description: "The repair shop offers a standing discount." },
      task_correspondence: { status: "possible", role: "task_input", component: "the repair shop's discount percentage" },
      event_time: { status: "unavailable" } };
    const standing = { ...standingBase, producer_id: SOURCE_TASK_OBSERVATION_PRODUCER_ID,
      source_task_observation: { status: "ready", interpretation_clock: CLOCK, observations: [standingObservation] } };
    const standingBaseline = await call(standingBase, { query: standingQuery });
    const standingPage = await call(standing, { query: standingQuery });
    expect(ids(standingBaseline)).not.toContain(standingTarget.root_id);
    expect(ids(standingPage)[0]).toBe(standingTarget.root_id);
    expect(standingPage.index!.entries[0]!.navigation?.task_observation).toMatchObject({
      temporal_relation: "unavailable", world_claim: "unknown", observation: { utterance: { kind: "standing" } } });
    for (const task_correspondence of [{ status: "unresolved" }, { status: "unsupported" },
      { status: "possible", role: "requested_event", component: "generic shop topic" }]) {
      const generic = { ...standing, source_task_observation: { ...standing.source_task_observation,
        observations: [{ ...standingObservation, task_correspondence }] } };
      expect(ids(await call(generic, { query: standingQuery }))).toEqual(ids(standingBaseline));
    }

    await resetWorker();
    const sameAsBaseline = async (observation: unknown) => {
      const result = await call({ ...candidate, source_task_observation: observation });
      expect(ids(result)).toEqual(ids(baseline));
    };
    const obs = candidate.source_task_observation.observations[0]!;
    await sameAsBaseline({ ...candidate.source_task_observation, observations: [{ ...obs,
      source_observed_at: "2026-09-09T00:00:00.000Z" }] });
    await sameAsBaseline({ ...candidate.source_task_observation, observations: [{ ...obs,
      source_excerpt: { ...obs.source_excerpt, text: sourceEvent.replace("silver", "golden") } }] });
    await sameAsBaseline({ ...candidate.source_task_observation, observations: [{ ...obs,
      query_excerpt: { ...obs.query_excerpt, text: "stale query details" } }] });
    await sameAsBaseline({ ...candidate.source_task_observation, observations: [{ ...obs, task_correspondence: { status: "unresolved" } }] });
    await sameAsBaseline({ ...candidate.source_task_observation, observations: [{ ...obs, task_correspondence: { status: "unsupported" } }] });
    await sameAsBaseline({ status: "failed", reason: "provider_failed" });
    await sameAsBaseline({ status: "unavailable", reason: "not_attempted" });
    await sameAsBaseline({ status: "ready", observations: "malformed" });
    await resetWorker();
    const noObservation = await call(undefined);
    const wrongQuery = await call({ ...candidate, original_query_digest: digest("different question") });
    expect(ids(wrongQuery)).toEqual(ids(noObservation));
    const wrongQuestionClock = await call({ ...candidate, question_time: { ...questionTime,
      interpretation_clock: "2026-09-17T00:00:00.000Z" } });
    expect(ids(wrongQuestionClock)).toEqual(ids(noObservation));
    await resetWorker();
    const hard = { since: "2026-09-17T00:00:00.000Z", until: "2026-09-17T23:59:59.999Z" };
    expect(ids(await call(candidate, hard))).toEqual(ids(await call(base, hard)));
    for (const guard of [{ since: hard.since }, { until: "2026-09-07T23:59:59.999Z" }]) {
      expect(ids(await call(candidate, guard))).toEqual(ids(await call(base, guard)));
    }
    expect(ids(await call(candidate, { scope_class: "global_core" }))).toEqual([]);
    const limited = fixture.repository.readTaskObservation(fixture.targets.find(row => row.source_id === "original-0")!,
      { start_byte: 0, end_byte: Buffer.byteLength(sourceText) }, { work_units: 0, memory_bytes: 0 });
    expect(limited.status).toBe("unknown");

    await resetWorker();
    const beforeErase = await call(candidate);
    expect(ids(beforeErase)[0]).toBe(target.root_id);
    expect(beforeErase.index!.continuation).not.toBeNull();
    const eraser = new SqliteFieldEraseBarrierRepo(fixture.database, fieldContractSha256);
    eraser.apply({ identity: hashLabeledIdentity("erase_barrier", [WS, "source_record", target.root_id, ""], fieldContractSha256),
      barrier_id: "erase-source-task-fixture", workspace_id: WS, generation_id: null,
      subject_kind: "source_record", subject_id: target.root_id, erased_at: CLOCK });
    const stale = await call(candidate, { continuation: beforeErase.index!.continuation });
    expect(stale.index?.completeness).toMatchObject({ logical_index: "invalidated", observed_coverage: "invalidated" });
    const afterErase = await call(candidate);
    expect(ids(afterErase)).not.toContain(target.root_id);
    expect(afterErase.index!.entries.every(entry => entry.navigation?.task_observation?.observation.source.root_id !== target.root_id)).toBe(true);
    await fixture.admit({ id: "original-1", text: "hinge repair discount needle replacement", eventTime: CLOCK }, "2");
    expect(ids(await call(standing, { query: standingQuery }))).not.toContain(standingTarget.root_id);
  }, { ...SIMULATED_CONFIGURATION, profile: { ...SIMULATED_CONFIGURATION.profile, max_input_tokens: 4096 } });
}, 30_000);
