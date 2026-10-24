import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); vi.restoreAllMocks(); });
afterAll(() => isolation.restore());
import { acquireProfiledSourceIndex, fieldContractSha256 } from "@do-soul/alaya-core";
import { canonicalJson, packSourceSemanticAcquisition, packSourceSemanticQueryPreparation,
  unavailableSourceQueryPreparation, sourceSemanticAccessPhases, type SourceSemanticAccessProfile,
  type SourceSemanticRetainedNominationWitness } from "@do-soul/alaya-protocol";
import { nativeSourceAccessPositions } from "../../../runtime/recall-read-worker/source-semantic-native-access.js";
import { SourceSemanticReadBudget } from "../../../runtime/field/source-semantic-read-stores.js";
import { sourceSemanticAccessReceiptValue, bindAccessPoolIdentity, quoteAccessPoolIdentity } from "../../../runtime/recall-read-worker/source-semantic-access-receipts.js";
import { sourceSemanticRevision } from "../../../runtime/recall-read-worker/source-semantic-leases.js";
import { attributeObservation } from "../../../../../bench-runner/src/runs/longmemeval-semantic/observation-attribution.js";
import { scoreConsumerMessageVisibility } from "../../../../../bench-runner/src/runs/longmemeval-semantic/message-visibility.js";
import { observeProfiledAcquisition } from "./profiled-acquisition-observation.test-support.js";
import { CLOCK, QUERY_BUDGET, WS, withIndexedSources } from "./source-semantic-index-acquisition.test-support.js";

const profile: SourceSemanticAccessProfile = { contract: "source-semantic-access-v3", result_version: "source-semantic-library-v7",
  protocol_version: 9, order_policy: "native-route-round-robin-v1", acquisition_policy: "source-index-grouped-round-robin.v1",
  channels: "dual", declared_allowance: { max_attempts: 64, max_roots: 18, max_vector_windows: 64 } };
const budget = { ...QUERY_BUDGET, work_units: 2_000_000, memory_bytes: 20_000_000 };
const sources = Array.from({ length: 18 }, (_, index) => ({ id: `source-${String(index).padStart(2, "0")}`,
  text: `needle ${index}`, vector: [1, 0, 0] }));

it("walks real captured SQLite pages beyond sixteen roots, paying duplicates within one attempt/window envelope", async () => {
  await withIndexedSources(sources, async fixture => {
    const prepared = await fixture.prepareQuery({ navigation: "needle", signal: new AbortController().signal, remainingMs: () => 60000 });
    const acquire = (candidate: SourceSemanticAccessProfile) => fixture.database.connection.transaction(() => acquireProfiledSourceIndex({
      repository: fixture.repository, sha256: fieldContractSha256, workspace: WS,
      original: { navigation: "needle", vector: prepared.vector }, profile: candidate, budget, admitScope: () => "admitted"
    }))();
    const small = acquire({ ...profile, declared_allowance: { ...profile.declared_allowance, max_roots: 16 } });
    const large = acquire(profile);
    expect(small.nominations).toHaveLength(16);
    expect(large.nominations).toHaveLength(18);
    expect(large.witness).toHaveLength(36);
    expect(large.phase.result).toMatchObject({ counts: { attempts: 36, retained_occurrences: 36,
      distinct_roots: 18, duplicate_occurrences: 18 }, vector: { inspected_windows: 18 },
    prefix_coverage: { kind: "retained_occurrence_prefix", omitted_occurrences: 20 } });
    expect(large.phase.result!.lanes.reduce((sum, lane) => sum + lane.consumed_occurrences, 0)).toBe(36);
    const fixed = { ...profile, acquisition_policy: "source-index-interleaved-prefix.v1" as const,
      declared_allowance: { ...profile.declared_allowance, max_roots: 16 } };
    expect(acquire({ ...fixed, order_policy: "query-conditioned-v1" }).nominations).toEqual(acquire(fixed).nominations);
  });
});

it("quotes and binds the same full witness preimage, including occurrence seventeen", async () => {
  await withIndexedSources(sources, async fixture => {
    const prepared = await fixture.prepareQuery({ navigation: "needle", signal: new AbortController().signal, remainingMs: () => 60000 });
    const produced = fixture.database.connection.transaction(() => acquireProfiledSourceIndex({ repository: fixture.repository,
      sha256: fieldContractSha256, workspace: WS, original: { navigation: "needle", vector: prepared.vector },
      profile, budget, admitScope: () => "admitted" }))();
    expect(Object.isFrozen(produced.witness)).toBe(true);
    const runtime = { database: fixture.database }, packing = new SourceSemanticReadBudget(budget);
    const receipt = sourceSemanticAccessReceiptValue(packing, "query-conditioned-v1", `sha256:${"a".repeat(64)}`,
      [], [], false, false, [], undefined, {
        preparation: packSourceSemanticQueryPreparation(unavailableSourceQueryPreparation("test_not_requested", "not_requested"), packing),
        acquisition: packSourceSemanticAcquisition(produced.phase, packing), observation: null
      }, profile);
    const altered = produced.witness.map((row, index) => index !== 16 ? row : { ...row, route: row.route.kind === "vector"
      ? { ...row.route, cosine: row.route.cosine / 2 } : { ...row.route, bm25: row.route.bm25 - 1 } });
    expect(altered.slice(0, 16)).toEqual(produced.witness.slice(0, 16));
    const bind = (retainedWitness: typeof produced.witness) => {
      const quote = quoteAccessPoolIdentity(runtime, WS, ["project"], receipt, new SourceSemanticReadBudget(budget), { retainedWitness });
      const actual = new SourceSemanticReadBudget({ work_units: quote.work_units, memory_bytes: quote.memory_bytes });
      const result = bindAccessPoolIdentity(runtime, WS, ["project"], receipt, actual, quote.prepared, retainedWitness);
      expect(actual.remaining()).toEqual({ work_units: 0, memory_bytes: 0 });
      const { phases: _phases, ...fields } = receipt;
      expect(result.pool_id).toBe(`sha256:${fieldContractSha256(canonicalJson({
        receipt: { ...fields, ...sourceSemanticAccessPhases(receipt) }, workspace: WS, authorized: ["project"],
        revision: sourceSemanticRevision(runtime), retained_witness: retainedWitness
      }))}`);
      return result.pool_id;
    };
    expect(bind(altered)).not.toBe(bind(produced.witness));
    expect(() => bindAccessPoolIdentity(runtime, WS, ["project"], receipt, new SourceSemanticReadBudget(budget))).toThrow(/full producer witness/);
  });
});

it("shares hints and original routes, denies unauthorized roots, and reports real budget refusal without widening allowances", async () => {
  await withIndexedSources([{ id: "allowed", text: "needle one", vector: [1, 0, 0] },
    { id: "denied", text: "needle two", vector: [1, 0, 0], scope: "global_core" }], async fixture => {
    const prepared = await fixture.prepareQuery({ navigation: "needle", supplemental_navigation: "needle extra",
      signal: new AbortController().signal, remainingMs: () => 60000 });
    const input = { repository: fixture.repository, sha256: fieldContractSha256, workspace: WS,
      original: { navigation: "needle", vector: prepared.vector }, hint: { navigation: "needle extra", vector: prepared.supplemental!.vector },
      profile, budget, admitScope: (scope: string | null) => scope === "project" ? "admitted" as const : "denied" as const };
    const result = fixture.database.connection.transaction(() => acquireProfiledSourceIndex(input))();
    expect(result.nominations.map(row => row.source_id)).toEqual(["allowed"]);
    expect(result.phase.result!.counts.denied).toBeGreaterThan(0);
    expect(result.phase.result!.counts.duplicate_occurrences).toBeGreaterThan(0);
    expect(result.phase.result!.lanes.some(lane => lane.view === "hint" && lane.consumed_occurrences > 0)).toBe(true);
    expect(result.phase.result!.counts.attempts).toBeLessThanOrEqual(profile.declared_allowance.max_attempts);
    expect(result.phase.result!.vector.inspected_windows).toBeLessThanOrEqual(profile.declared_allowance.max_vector_windows);
    expect(() => fixture.database.connection.transaction(() => acquireProfiledSourceIndex({ ...input,
      budget: { work_units: 1, memory_bytes: 2000 } }))()).toThrow();
    vi.spyOn(fixture.repository, "readLexicalCandidates").mockImplementation(() =>
      fixture.database.connection.prepare("SELECT * FROM missing_source_table").get() as never);
    const failed = fixture.database.connection.transaction(() => acquireProfiledSourceIndex(input))();
    expect(failed.phase).toMatchObject({ status: "failed", accounting: "partial", result: { completion: "partial",
      counts: { attempts: 0, resource_refused_before_start: 0, resource_refused_after_start: 0 } } });
    expect(failed.phase.result!.resource_refusals).toHaveLength(2);
    expect(failed.phase.result!.resource_refusals.every(row => row.phase === "acquisition_failed_unknown_additional_cost")).toBe(true);
  });
});

it("keeps profiled acquisition observation off/on/overflow noninterfering and attributes full retained occurrences separately from malformed detail", async () => {
  await withIndexedSources(sources, async fixture => {
    const off = await observeProfiledAcquisition(fixture, profile);
    const on = await observeProfiledAcquisition(fixture, profile, { max_events: 2048, max_bytes: 524288 });
    const bounded = await observeProfiledAcquisition(fixture, profile, { max_events: 0, max_bytes: 0 });
    for (const observed of [on, bounded]) {
      expect(observed.phase).toEqual(off.phase); expect(observed.witness).toEqual(off.witness);
      expect(observed.work).toEqual(off.work);
    }
    expect(bounded.observation!.status).toBe("overflow");
    const frame = on.observation!, event = frame.events.find(row => row.kind === "source_index_routes")!;
    const evidence = event.data as { retained_occurrences: SourceSemanticRetainedNominationWitness };
    expect(evidence.retained_occurrences).toHaveLength(36);
    const occurrence = evidence.retained_occurrences[16]!, target = occurrence.source.target;
    if (occurrence.source.source_id === null) throw new Error("expected a native SourceRecord nomination");
    const answer = { unit: "published_body_utf8_bytes" as const, annotated_turns: 1, complete: true,
      spans: [{ session_index: 0, message_index: 0, source_id: occurrence.source.source_id,
        target: { workspace_id: WS, root_kind: "source_record" as const, root_id: target.root_id,
          source_version: target.source_version, content_digest: target.content_digest }, start: 0, end: 1 }] };
    const call = { kind: "prepare_query" as const, request_id: frame.request_id, session_id: frame.facts!.binding!.session_id,
      query_key: "synthetic", snapshot_id: null, workspace_id: WS, as_of: CLOCK };
    const attribute = (observation: typeof frame) => attributeObservation({ question_id: "synthetic", k: 5, call,
      frames: [{ call, observation }], frozen_index: null, admitted_roots: new Map(), admitted_roots_complete: false,
      answer_gold: answer, visibility: scoreConsumerMessageVisibility({ gold: answer, pages: [] }) });
    const route = (value: ReturnType<typeof attribute>) => value.messages[0]!.routes.find(row => row.route === `index:${occurrence.view}:${occurrence.route.kind}`)!;
    expect(route(attribute(frame)).native?.occurrence_evidence).toBe("full_retained");
    expect(route(attribute(frame)).native?.retained_occurrences?.length).toBeGreaterThan(0);
    expect(route(attribute(frame)).eligibility).toBe("unknown");
    const malformed = structuredClone(frame), bad = malformed.events.find(row => row.kind === "source_index_routes")!;
    const detail = bad.data as { retained_occurrences: { route: { native_rank: number } }[] };
    detail.retained_occurrences[16]!.route.native_rank = -1;
    expect(route(attribute(malformed)).diagnostic_issues.some(issue => issue.field === "retained_occurrences")).toBe(true);
    expect(route(attribute(malformed)).native?.occurrence_evidence).toBe("displayed_prefix");
    const actualRecords = await fixture.admit({ id: "catalog-only", text: "no captured position" });
    expect(() => nativeSourceAccessPositions([actualRecords], [], undefined, true, new SourceSemanticReadBudget(budget))).toThrow(/non_total/);
  });
});
