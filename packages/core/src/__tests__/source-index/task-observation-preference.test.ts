import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../apps/bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); });
afterAll(() => isolation.restore());
import { type SourceIndexAcquisitionInput, type SourceIndexLexicalRead,
  type SourceIndexQueryRepository, type SourceIndexTarget, type SourceIndexTaskObservationRead, type SourceTaskObservationProposal } from "@do-soul/alaya-protocol";
import { SourceIndexAcquisition } from "../../source-index/source-index-acquisition.js";
import type { SourceIndexAcquisitionFact } from "../../source-index/acquisition-observation.js";
import type { SourcePreferenceRetention } from "../../source-index/question-time-preference.js";
import { fieldSha256 } from "../../../../storage/src/__tests__/repos/source-index/source-index-fixture.js";
import { readResources, templateBudget, templateStatement } from "./source-template-fixture.js";

const empty = { work: 0, memory_bytes: 0, native_bytes: 0, sql_internal_work: "unknown" as const };
function fixture() {
  const originals = Array.from({ length: 16 }, (_, i) => templateStatement(`original-${i}`));
  const preferred = Array.from({ length: 16 }, (_, i) => templateStatement(`preferred-${i}`));
  const read = vi.fn<(source: SourceIndexTarget) => SourceIndexTaskObservationRead>(source => ({ status: "ready",
    text: originals.find(row => row.source.source_id === source.source_id)?.body ?? "",
    source_observed_at: "2026-09-01T00:00:00.000Z", resources: readResources }));
  const lexical = (rows: typeof originals): SourceIndexLexicalRead => ({ completion: "complete", reason: null,
    candidates: rows.map((row, i) => ({ source: row.source, lexical: { lane: "unicode61", rank: i + 1,
      lane_rank: i + 1, bm25: -1 } })), resources: empty, resource_refusal: null,
    index_coverage: "partial", limitations: [], tokenization: null });
  const repository: SourceIndexQueryRepository = {
    readLexicalCandidates: (_workspace, _query, _limit, _budget, preference) => lexical(preference === undefined ? originals : preferred),
    readQuestionTimeDomain: () => ({ status: "ready", exists: true, matched_root_keys: [], resources: empty }),
    readTaskObservation: read,
    readVectorCandidates: () => ({ completion: "complete", reason: null, candidates: [], resources: empty,
      state: { status: "unavailable", reason: "fixture" }, resource_refusal: null, cursor: null, inspected: 0, invalid: 0 }),
    admitQueryCandidate: () => ({ status: "ready", scope_class: "project", resources: empty })
  };
  const text = originals[0]!.body, clock = "2026-09-07T00:00:00.000Z";
  const proposal = { status: "ready" as const, interpretation_clock: clock, observations: [{ source: originals[0]!.source.target,
    source_observed_at: "2026-09-01T00:00:00.000Z", source_excerpt: { start_byte: 0, end_byte: Buffer.byteLength(text), text },
    query_excerpt: { start_byte: 0, end_byte: 4, text: "game" }, utterance: { kind: "reported_event" as const, description: "a game was completed" },
    task_correspondence: { status: "possible" as const, role: "requested_event" as const, component: "completed game" },
    event_time: { status: "unavailable" as const } }] };
  const input: SourceIndexAcquisitionInput = { workspace_id: "workspace-template", navigation_text: "game",
    vector: { status: "unavailable", reason: "fixture" }, allowance: { max_attempts: 128, max_roots: 16, max_vector_windows: 0 },
    budget: templateBudget, question_time: { interpretation_clock: clock, intervals: [{ start: "2026-09-02", end: "2026-09-06" }] } };
  const observed: SourceIndexAcquisitionFact[] = [];
  const retain = vi.fn<SourcePreferenceRetention["retain"]>((capture, meter) => {
    const before = meter.spentBytes; meter.retain(capture, "fixture actual nomination retention"); return meter.spentBytes - before;
  });
  const run = (enabled = true, supplied: SourceTaskObservationProposal = proposal, observationSourceId?: string) =>
    new SourceIndexAcquisition(repository, fieldSha256).nominateWithWitness({ ...input,
      ...(enabled ? { source_task_observation: supplied } : {}) }, () => "admitted", "original",
    capture => { observed.push(capture()); }, { status: "ready", vectors: [Float32Array.of(1)], conditions: [{ statement: "s", speaker: "user", anchors: [] }] }, { retain }, observationSourceId);
  return { originals, preferred, repository, read, retain, run, observed, proposal };
}

it("records the pre-observation eligibility union without a proposal and preserves partial acquisition", () => {
  const env = fixture(), baseline = env.run(false);
  const fact = env.observed.find(row => row.kind === "source_task_inventory");
  expect(fact).toMatchObject({ kind: "source_task_inventory", state: "active", coverage: "partial",
    original: env.originals.map(row => row.source), incumbent: env.preferred.map(row => row.source),
    eligible: [...env.originals, ...env.preferred].map(row => row.source) });
  expect(baseline.result.nominations.map(row => row.source)).toEqual(env.preferred.map(row => row.source));
  expect(env.read).not.toHaveBeenCalled();
});

it("narrows only task eligibility for a source-bound query without a proposal", () => {
  const env = fixture();
  env.run(false, env.proposal, "original-0");
  expect(env.observed.find(row => row.kind === "source_task_inventory")).toMatchObject({ state: "active",
    original: env.originals.map(row => row.source), incumbent: env.preferred.map(row => row.source),
    eligible: [env.originals[0]!.source] });
});

it("reports an unavailable second time-domain read without inventing an incumbent", () => {
  const env = fixture();
  vi.spyOn(env.repository, "readQuestionTimeDomain").mockReturnValueOnce({ status: "ready", exists: true,
    matched_root_keys: [], resources: empty }).mockReturnValueOnce({ status: "unavailable", reason: "question_time_read_failed",
    resources: empty });
  const result = env.run(false);
  expect(result.result.nominations.map(row => row.source)).toEqual(env.originals.map(row => row.source));
  expect(env.observed).toContainEqual(expect.objectContaining({ kind: "source_task_inventory", state: "unavailable",
    coverage: "partial", reason: "question_time_read_failed", original: env.originals.map(row => row.source) }));
  const inventory = env.observed.find(row => row.kind === "source_task_inventory");
  expect(inventory).not.toHaveProperty("eligible");
});

it("distinguishes valid-empty from missing selected endpoints without promoting descriptive reports", () => {
  const env = fixture(), baseline = env.run(false);
  for (const coverage of ["ready", "partial"] as const) {
    expect(env.run(true, { ...env.proposal, status: coverage, observations: [] }).result.nominations)
      .toEqual(baseline.result.nominations);
    expect(env.observed).toContainEqual({ kind: "source_task_observation", observation: {
      status: "unchanged", observed: 0, preferred: 0, producer_coverage: coverage, invalid: 0, unavailable: 0 } });
  }
  const event = { ...env.proposal.observations[0]!,
    utterance: { kind: "reported_event" as const, description: "An unrelated game was completed." },
    task_correspondence: { status: "unsupported" as const } };
  expect(env.run(true, { ...env.proposal, observations: [event] }).result.nominations).toEqual(baseline.result.nominations);
  expect(env.read).toHaveBeenCalledTimes(1);
  expect(env.observed).toContainEqual({ kind: "source_task_observation", observation: {
    status: "unknown", observed: 1, preferred: 0, producer_coverage: "ready", invalid: 0, unavailable: 1,
    reason: "source_task_association_unavailable" } });
});

it("keeps an unbound report unknown while independently recording an invalid clock", () => {
  const env = fixture(), baseline = env.run(false), valid = env.proposal.observations[0]!, other = env.originals[1]!;
  const invalid = { ...valid, source: other.source.target, source_observed_at: "2026-09-02T00:00:00.000Z",
    source_excerpt: { start_byte: 0, end_byte: Buffer.byteLength(other.body), text: other.body } };
  const result = env.run(true, { ...env.proposal, status: "partial", observations: [valid, invalid] });
  expect(result.result.nominations).toEqual(baseline.result.nominations);
  expect(env.observed).toContainEqual({ kind: "source_task_observation", observation: {
    status: "unknown", observed: 1, preferred: 0, producer_coverage: "partial", invalid: 1, unavailable: 1,
    reason: "source_task_association_unavailable" } });
});

it("stops the optional change if a later read has unknown additional cost", () => {
  const env = fixture(), baseline = env.run(false), valid = env.proposal.observations[0]!, other = env.originals[1]!;
  const second = { ...valid, source: other.source.target,
    source_excerpt: { start_byte: 0, end_byte: Buffer.byteLength(other.body), text: other.body } };
  env.read.mockImplementation(source => source.source_id === "original-0"
    ? { status: "ready", text: env.originals[0]!.body, source_observed_at: "2026-09-01T00:00:00.000Z", resources: readResources }
    : { status: "unknown", reason: "source_task_read_failed_unknown_additional_cost", resources: readResources });
  const result = env.run(true, { ...env.proposal, observations: [valid, second] });
  expect(result.result.nominations).toEqual(baseline.result.nominations);
  expect(result.result.resources.native_bytes).toBe(2 * readResources.native_bytes);
  expect(env.observed).toContainEqual({ kind: "source_task_observation", observation: expect.objectContaining({
    status: "unknown", reason: "source_task_read_failed_unknown_additional_cost" }) });
});

it("keeps an unreadable source unknown instead of selecting it or treating it as empty", () => {
  const env = fixture(), baseline = env.run(false);
  env.read.mockReturnValue({ status: "unknown", reason: "source_task_read_budget", resources: readResources });
  const result = env.run();
  expect(result.result.nominations).toEqual(baseline.result.nominations);
  expect(result.result.resources.native_bytes).toBe(readResources.native_bytes);
  expect(env.observed).toContainEqual({ kind: "source_task_observation", observation: expect.objectContaining({
    status: "unknown", reason: "source_task_read_budget" }) });
});
