import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, expect, it, vi } from "vitest";
import { SoulInterpretationRequestSchema, SourceSemanticAccessReceiptSchema, SourceSemanticWorkerWorkSchema,
  sourceSemanticAcquisitionNotRun, sourceSemanticExecutionPhases, unavailableSourceQueryPreparation,
  type SoulInterpretationRequest, type SourceSemanticWorkerWork } from "@do-soul/alaya-protocol";
import { sourceSemanticLibraryRequestIdentity } from "@do-soul/alaya-core";
import { createSourceSemanticInterpretationHandler } from "../../../../../core-daemon/src/mcp-memory/tool/interpretation-handler.js";
import { CLOCK, WS, accessQuery, withAccessLibrary } from
  "../../../../../core-daemon/src/__tests__/runtime/recall/source-semantic-access.test-support.js";
import { chainIdentity } from "../../../runs/semantic-chain/contract.js";
import { freezeRecoveryAllowance, recordRecoveryNativeWork, reserveRecoveryAction,
  reserveRecoveryHostEffect, reserveRecoveryRead } from "../../../runs/semantic-chain/recovery-allowance.js";
import { recordSourceSemanticLibraryFirstExposure } from "../../../runs/measurement/source-semantic-library-recall.js";
import { measureSourceSemanticLibraryResponse } from "../../../runs/measurement/source-semantic-library-measurement.js";
import { ACCESS_CASES, ARMS, ORIGINAL_QUERY, REQUEST_BUDGET, RESERVATION_SCHEDULE, TASK_ALLOWANCE,
  candidateDiscovery, caseSources, compareCandidateDiscovery, evidenceChecklist, executionBinding,
  observationIdentitySummary, publicSources, readAllowanceLedger, readNativeManifest,
  type AccessCase, type Arm, type Delivery, type ManifestSource, type Preparation } from "./source-access-contrast.test-support.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const query = accessQuery(ORIGINAL_QUERY);
const scopes = { mode: "named" as const, scopes: ["project"] };
type Handler = ReturnType<typeof createSourceSemanticInterpretationHandler>;
type ActionFailure = { status: "reservation_refused" | "terminal_native_error"; message: string; actual_work: "unknown" | SourceSemanticWorkerWork };
type Round = { round: "initial" | "second"; original_query: string; access_hint: string | null;
  prepare?: Preparation; delivery?: Delivery; failure?: ActionFailure };

async function reservedCall(root: string, name: string, request: SoulInterpretationRequest, handler: Handler) {
  try {
    reserveRecoveryAction(root, name, chainIdentity(request), REQUEST_BUDGET.work_units,
      REQUEST_BUDGET.memory_bytes, false);
  } catch (error) {
    return { failure: { status: "reservation_refused", message: String(error), actual_work: "unknown" } as ActionFailure };
  }
  let response;
  try {
    response = await handler(request, { workspaceId: WS, runId: "source-access",
      agentTarget: "codex", sessionId: root });
  } catch (error) {
    const details = error !== null && typeof error === "object" && "details" in error
      ? error.details as { work?: unknown } | undefined : undefined;
    const meter = SourceSemanticWorkerWorkSchema.safeParse(details?.work);
    if (meter.success) recordRecoveryNativeWork(root, name, meter.data);
    return { failure: { status: "terminal_native_error", message: String(error),
      actual_work: meter.success ? meter.data : "unknown" } as ActionFailure };
  }
  recordRecoveryNativeWork(root, name, response.work);
  return { response };
}

async function observeRound(root: string, arm: Arm, round: Round["round"], handler: Handler): Promise<Round> {
  const hint = round === "second" ? arm.access_hint : undefined;
  const result: Round = { round, original_query: ORIGINAL_QUERY, access_hint: hint ?? null };
  const preparation = SoulInterpretationRequestSchema.parse({ operation: "prepare_query", original_query: ORIGINAL_QUERY,
    query_semantics: query, budget: REQUEST_BUDGET, authorized_scopes: scopes,
    ...(hint === undefined ? {} : { access_hint: hint }) });
  const prepared = await reservedCall(root, `${round}-prepare`, preparation, handler);
  if (prepared.failure !== undefined) return { ...result, failure: prepared.failure };
  if (prepared.response.operation !== "prepare_query") throw new Error("preparation expected");
  result.prepare = prepared.response;
  if (prepared.response.query_handle === undefined || prepared.response.outcome !== undefined) return result;
  const recalled = await reservedCall(root, `${round}-delivery`, SoulInterpretationRequestSchema.parse({
    operation: "recall", accepts_unreviewed_conditional_results: true,
    query_handle: prepared.response.query_handle, semantic_correspondences: [], budget: REQUEST_BUDGET,
    output_byte_limit: 1_000_000, authorized_scopes: scopes }), handler);
  if (recalled.failure !== undefined) return { ...result, failure: recalled.failure };
  if (recalled.response.operation !== "recall") throw new Error("public recall expected");
  result.delivery = recalled.response;
  return result;
}

function describeRound(round: Round, manifest: readonly ManifestSource[], fixture: AccessCase) {
  const { prepare, delivery } = round;
  const delivered = publicSources(delivery, manifest);
  const exposure = delivery?.index === undefined ? null : recordSourceSemanticLibraryFirstExposure(delivery);
  const evaluation = exposure === null ? null : measureSourceSemanticLibraryResponse({
    recallResult: delivery, firstExposurePage: exposure, requestBudget: REQUEST_BUDGET, goldSourceUnits: [] });
  return { round: round.round, original_query: round.original_query, access_hint: round.access_hint,
    failure: round.failure ?? null, preparation_outcome: prepare?.outcome ?? (prepare?.query_handle === undefined ? "unavailable" : "prepared"),
    query_semantics_id: prepare?.query_semantics_id ?? null, query_semantics_status: prepare?.query_semantics_status ?? null,
    preparation_candidates: prepare?.candidates.map(candidate => ({ source_id: candidate.source_id,
      source_interpretation_id: candidate.interpretation_id, source_version: candidate.source_version,
      content_digest: candidate.content_digest })) ?? null,
    preparation_access: prepare?.access ?? null, delivery_access: delivery?.discovery?.access ?? null,
    observed_identity_summary: observationIdentitySummary(prepare?.access, delivery?.discovery?.access),
    public_delivery: delivery === undefined ? null : { request_identity: delivery.request_identity,
      delivery_id: delivery.delivery_id, index: delivery.index, sources: delivered, proofs: delivery.proofs ?? [],
      unproved_computations: delivery.unproved_computations ?? [], coverage: delivery.coverage, discovery: delivery.discovery },
    first_exposure: exposure, independent_gold_any_at_5: { status: "unavailable", reason: "no independent gold source units" },
    measurement: evaluation?.measurement?.status === "validated"
      ? { status: "validated", metrics: evaluation.measurement.metrics } : evaluation?.measurement ?? null,
    evaluator_usage: evaluation?.evaluator_usage ?? "unknown",
    delivered_evidence: evidenceChecklist(fixture, delivered.map(source => source.text)),
    task_visible_evidence: evidenceChecklist(fixture, [fixture.initial, ...delivered.map(source => source.text)]),
    response_bytes: { preparation: prepare === undefined ? null : Buffer.byteLength(JSON.stringify(prepare)),
      delivery: delivery === undefined ? null : Buffer.byteLength(JSON.stringify(delivery)) },
    actual_worker_work: { preparation: prepare?.work ?? "unknown", delivery: delivery?.work ?? "unknown" } };
}

function checkRound(round: Round) {
  expect(round.original_query).toBe(ORIGINAL_QUERY);
  for (const response of [round.prepare, round.delivery]) {
    if (response === undefined) continue;
    expect(sourceSemanticExecutionPhases(response.execution).query_preparation.external_api_attempts).toBe(0);
    expect(response.work.logical_work ?? response.work.native_work).toBeLessThanOrEqual(REQUEST_BUDGET.work_units);
    expect(response.work.logical_memory_bytes).toBeLessThanOrEqual(REQUEST_BUDGET.memory_bytes);
  }
  if (round.delivery === undefined) return;
  expect(round.delivery.request_identity).toBe(sourceSemanticLibraryRequestIdentity({ workspace_id: WS, as_of: CLOCK,
    authorized_scopes: scopes.scopes, original_query: ORIGINAL_QUERY, query_semantics: query,
    query_semantics_status: round.prepare!.query_semantics_status, access_policy: "query-conditioned-v1",
    ...(round.access_hint === null ? {} : { access_hint: round.access_hint }),
    semantic_correspondences: [], budget: REQUEST_BUDGET, output_byte_limit: 1_000_000 }));
  expect(round.delivery.proofs ?? []).toEqual([]);
  expect(round.delivery.coverage.conditional_computation).toBe("unexercised");
  expect(Buffer.byteLength(JSON.stringify(round.delivery))).toBeLessThanOrEqual(1_000_000);
}

async function observeArm(root: string, arm: Arm, handler: Handler, fixture: AccessCase, manifest: readonly ManifestSource[],
  execution: ReturnType<typeof executionBinding>) {
  const initial = await observeRound(root, arm, "initial", handler);
  const initialTexts = publicSources(initial.delivery, manifest).map(source => source.text);
  const visible = evidenceChecklist(fixture, [fixture.initial, ...initialTexts]);
  const terminal = initial.failure !== undefined || initial.prepare?.query_handle === undefined
    || initial.prepare?.outcome !== undefined || initial.delivery === undefined;
  let second: Round | undefined;
  if (!terminal && !visible.task_answer_resolved) {
    reserveRecoveryRead(root, "optional authored access input");
    second = await observeRound(root, arm, "second", handler);
  }
  reserveRecoveryRead(root, "final evidence and allowance assessment");
  const initialReport = describeRound(initial, manifest, fixture);
  const secondReport = second === undefined ? null : describeRound(second, manifest, fixture);
  const firstIds = new Set(initialReport.observed_identity_summary.explicit_read_source_rows.map(row => row.source_id));
  const laterIds = secondReport?.observed_identity_summary.explicit_read_source_rows.map(row => row.source_id) ?? [];
  const candidateInitiallyObserved = firstIds.has("candidate");
  const candidateNewlyObserved = candidateDiscovery({ terminal, identities: initialReport.observed_identity_summary },
    secondReport === null ? undefined : { terminal: second?.failure !== undefined || second?.delivery === undefined,
      identities: secondReport.observed_identity_summary });
  reserveRecoveryHostEffect(root, "result-output", chainIdentity({ case: fixture.name, arm: arm.name }), false);
  const ledger = readAllowanceLedger(join(root, "recovery-allowance.sqlite"));
  const nativeTotals = ledger.actual_native_observations.reduce((sum, row) => ({
    native_work: sum.native_work + row.work.native_work, native_bytes: sum.native_bytes + row.work.native_bytes,
    logical_work: sum.logical_work + (row.work.logical_work ?? row.work.native_work),
    logical_memory_bytes: sum.logical_memory_bytes + row.work.logical_memory_bytes
  }), { native_work: 0, native_bytes: 0, logical_work: 0, logical_memory_bytes: 0 });
  const report = { arm: arm.name, ...execution, hint_author: arm.access_hint === undefined ? "not_applicable" : "fixed_authored_oracle",
    author_knowledge: arm.author_knowledge,
    already_visible_source: "initial", initial: initialReport, second: secondReport,
    second_stop_reason: second !== undefined ? "one_additional_observation_completed_or_terminal"
      : terminal ? "terminal_initial_no_result" : "visible_raw_evidence_already_sufficient",
    candidate_newly_observed: candidateNewlyObserved,
    candidate_explicitly_observed_initially: candidateInitiallyObserved,
    initial_observed_identities_complete: initialReport.observed_identity_summary.unrepresented_observed_source_identities === 0,
    later_observed_ids_absent_from_explicit_initial_rows: laterIds.filter(id => !firstIds.has(id)),
    cumulative_explicit_native_read_source_ids: [...new Set([...firstIds, ...laterIds])],
    cumulative_task_evidence: evidenceChecklist(fixture, [fixture.initial, ...initialTexts,
      ...publicSources(second?.delivery, manifest).map(source => source.text)]),
    allowance: ledger, measured_native_subtotal: nativeTotals,
    native_subtotal_complete: initial.failure === undefined && second?.failure === undefined,
    setup_actual_native_work: "unknown", total_lifecycle_cost: "unknown",
    initial_any_at_5: initialReport.independent_gold_any_at_5,
    second_any_at_5: secondReport?.independent_gold_any_at_5 ?? "not_executed",
    cumulative_any_at_5: "not_a_first_exposure_metric", automatic_clue_generation: "not_exercised" };
  return { report, check: () => {
    checkRound(initial);
    if (second !== undefined) {
      checkRound(second);
      if (initial.prepare !== undefined && second.prepare !== undefined) {
        expect(second.prepare.query_semantics_id).toBe(initial.prepare.query_semantics_id);
        expect(second.prepare.query_semantics_status).toEqual(initial.prepare.query_semantics_status);
      }
    }
    expect(ledger.work_reserved).toBeLessThanOrEqual(TASK_ALLOWANCE.total_work_units);
    expect(ledger.memory_reserved).toBeLessThanOrEqual(TASK_ALLOWANCE.total_memory_bytes);
    const secondActions = ledger.actions.filter(action => String(action.name).startsWith("second-"));
    expect(secondActions.length).toBeLessThanOrEqual(second === undefined ? 0 : 2);
    if (second?.delivery !== undefined) expect(secondActions.map(action => action.name)).toEqual(["second-prepare", "second-delivery"]);
  } };
}

it.each(ACCESS_CASES)("records authored access contrast without requiring a clue win: $name", async fixture => {
  const execution = executionBinding(process.env.ALAYA_ACCESS_IMPLEMENTATION_REVISION);
  const directory = mkdtempSync(join(tmpdir(), "source-access-contrast-")); roots.push(directory);
  const sources = caseSources(fixture), corpusPath = join(directory, "frozen-corpus.json");
  writeFileSync(corpusPath, JSON.stringify({ original_query: ORIGINAL_QUERY, query_semantics: query,
    sources, arms: ARMS, request_budget: REQUEST_BUDGET, allowance: TASK_ALLOWANCE, schedule: RESERVATION_SCHEDULE, ...execution }));
  const ledgers = ARMS.map(arm => ({ arm, root: join(directory, arm.name) }));
  for (const { arm, root } of ledgers) {
    freezeRecoveryAllowance(root, chainIdentity({ fixture, arm, query, sources, ...execution }), TASK_ALLOWANCE, corpusPath);
    reserveRecoveryRead(root, "common frozen input");
    reserveRecoveryAction(root, "common-source-setup", chainIdentity(sources), 40_000, 2_000_000, false);
  }
  const observations: Awaited<ReturnType<typeof observeArm>>[] = [];
  for (const { arm, root } of ledgers) {
    const setupStart = performance.now();
    await withAccessLibrary(sources, async ({ execute, filename, ids }) => {
      const setupElapsed = performance.now() - setupStart;
      reserveRecoveryRead(root, "native source identity manifest", [filename]);
      const manifest = readNativeManifest(filename);
      expect(manifest.map(source => source.source_body)).toEqual(sources.map(source => source.text));
      expect(manifest).toHaveLength(34);
      expect([...ids.values()].flat()).toHaveLength(fixture.interpreted ? 1 : 0);
      if (process.env.ALAYA_TEST_SOURCE_ACCESS_DIAGNOSTICS === "1") console.info("SOURCE_ACCESS_MANIFEST " + JSON.stringify({ case: fixture.name, arm: arm.name, ...execution,
        query: ORIGINAL_QUERY, query_semantics: query, sources: manifest, published_interpretations: Object.fromEntries(ids),
        request_budget: REQUEST_BUDGET, task_allowance: TASK_ALLOWANCE, reservation_schedule: RESERVATION_SCHEDULE,
        worker_isolation: "fresh_database_and_worker_per_arm",
        source_bytes: sources.reduce((sum, source) => sum + Buffer.byteLength(source.text), 0),
        publication_count: fixture.interpreted ? 1 : 0, setup_elapsed_ms: setupElapsed,
        setup_native_work: "unknown", setup_reservation_is_accounting_charge: true }));
      const handler = createSourceSemanticInterpretationHandler({ now: () => CLOCK, sourceSemanticsPort: { execute } });
      observations.push(await observeArm(root, arm, handler, fixture, manifest, execution));
    });
  }
  const reports = observations.map(observation => observation.report);
  if (process.env.ALAYA_TEST_SOURCE_ACCESS_DIAGNOSTICS === "1") console.info("SOURCE_ACCESS_REPORT " + JSON.stringify({ case: fixture.name, arms: reports, ...execution,
    c_outperformed_both_on_new_candidate_discovery: compareCandidateDiscovery(reports),
    worker_isolation: "fresh_database_and_worker_per_arm",
    a_operation: "fresh preparation under unchanged original query; not a true cursor continuation",
    consumer_accuracy: "not_exercised", natural_source_utility: "not_exercised", provider_calls: 0 }));
  for (const observation of observations) observation.check();
  const initialWork = reports.map(report => report.initial.actual_worker_work.preparation);
  if (initialWork.every(work => typeof work !== "string")) {
    expect(new Set(initialWork.map(work => work.logical_work ?? work.native_work)).size).toBe(1);
  }
}, 60_000);

it.each(["duplicate", "exhausted"] as const)("refuses a %s reservation before invoking native access", async condition => {
  const root = mkdtempSync(join(tmpdir(), "source-access-reservation-")); roots.push(root);
  freezeRecoveryAllowance(root, "reservation-control", TASK_ALLOWANCE, join(root, "unused-input.json"));
  const request = SoulInterpretationRequestSchema.parse({ operation: "prepare_query", original_query: ORIGINAL_QUERY,
    query_semantics: query, budget: REQUEST_BUDGET, authorized_scopes: scopes });
  if (condition === "duplicate") reserveRecoveryAction(root, "initial-prepare", chainIdentity(request),
    REQUEST_BUDGET.work_units, REQUEST_BUDGET.memory_bytes, false);
  else reserveRecoveryAction(root, "prior-work", "prior-work", 900_000, 1_000, false);
  const handler = vi.fn<Handler>();
  const result = await reservedCall(root, "initial-prepare", request, handler);
  expect(result.failure?.status).toBe("reservation_refused");
  expect(result.failure?.message).toMatch(condition === "duplicate" ? /no durable result/u : /total allowance exhausted/u);
  expect(handler).not.toHaveBeenCalled();
});

function accessReceipt(sourceIds: readonly string[], observedCount = sourceIds.length, delivery = false) {
  return SourceSemanticAccessReceiptSchema.parse({ contract: "source-semantic-access-v2",
    preparation: unavailableSourceQueryPreparation("controlled_or_scoped_access", "not_requested"),
    acquisition: sourceSemanticAcquisitionNotRun("controlled_or_scoped_access"),
    phase_accounting: {
      observation: null, completion: "included_in_worker_work_not_separately_measured",
      native_cpu: "unknown", deadline: "soft_quarantine_until_exit"
    },
    policy: "query-conditioned-v1",
    input_id: `sha256:${"a".repeat(64)}`, pool_id: `sha256:${"b".repeat(64)}`,
    observed_source_count: observedCount, observed_interpretation_count: 0,
    source_candidates: sourceIds.map(source_id => ({ source_id,
      record_id: `sha256:${(source_id === "candidate" ? "99" : source_id.slice(2)).padStart(64, "0")}`,
      read_bytes: 1, body_bytes: 1, complete: true,
      signal: { source_text_score: 0, interpretation_reading_score: 0 } })),
    interpretation_candidates: [], trace: { kind: delivery ? "library_selection" : "preparation_page",
      ...(delivery ? {} : { source_offset: 0, interpretation_offset: 0 }),
      omitted_source_count: observedCount - sourceIds.length, omitted_interpretation_count: 0 },
    unvisited_sources: false, unvisited_interpretations: false, stopping_reasons: [] });
}

it("keeps overlapping receipt omissions distinct from unrepresented observed identities", () => {
  const sources = Array.from({ length: 16 }, (_, index) => `s-${index + 1}`);
  const initial = observationIdentitySummary(accessReceipt(sources, 34), accessReceipt(sources.slice(0, 5), 34, true));
  expect(initial.receipt_omissions).toEqual({ preparation: 18, delivery: 29 });
  expect(initial.explicit_record_ids).toHaveLength(16);
  expect(initial.explicit_read_source_rows).toHaveLength(16);
  expect(initial.unrepresented_observed_source_identities).toBe(18);
  const second = observationIdentitySummary(accessReceipt(["candidate"]), accessReceipt(["candidate"], 1, true));
  expect(candidateDiscovery({ terminal: false, identities: initial }, { terminal: false, identities: second }))
    .toEqual({ status: "unknown", value: null, reason: "initial_observed_identities_omitted" });
});

it("keeps missing receipts, terminal failures and a later omitted candidate unknown", () => {
  const complete = observationIdentitySummary(accessReceipt(["s-1"]), accessReceipt(["s-1"], 1, true));
  const missing = observationIdentitySummary(accessReceipt(["s-1"]));
  const omitted = observationIdentitySummary(accessReceipt(["s-1"], 2), accessReceipt(["s-1"], 2, true));
  expect(candidateDiscovery({ terminal: false, identities: missing }))
    .toEqual({ status: "unknown", value: null, reason: "initial_missing_access_receipt" });
  expect(candidateDiscovery({ terminal: true, identities: complete }))
    .toEqual({ status: "unknown", value: null, reason: "terminal_initial_no_result" });
  expect(candidateDiscovery({ terminal: false, identities: complete }, { terminal: true, identities: missing }))
    .toEqual({ status: "unknown", value: null, reason: "terminal_second_no_result" });
  expect(candidateDiscovery({ terminal: false, identities: complete }, { terminal: false, identities: omitted }))
    .toEqual({ status: "unknown", value: null, reason: "second_observed_identities_omitted" });
});

it("distinguishes a repeated source from a confirmed first observation without requiring a study win", () => {
  const absent = { terminal: false, identities: observationIdentitySummary(accessReceipt(["s-1"]), accessReceipt(["s-1"], 1, true)) };
  const present = { terminal: false, identities: observationIdentitySummary(accessReceipt(["candidate"]), accessReceipt(["candidate"], 1, true)) };
  expect(candidateDiscovery(present, present))
    .toEqual({ status: "known", value: false, reason: "candidate_already_observed_initially" });
  expect(candidateDiscovery(absent, present))
    .toEqual({ status: "known", value: true, reason: "candidate_first_observed_in_second_round" });
});

it.each(["A", "B", "C"] as const)("keeps an unknown %s arm unknown in the comparative outcome", unknownArm => {
  const arms = ARMS.map(({ name }) => ({ arm: name, candidate_explicitly_observed_initially: false,
    initial_observed_identities_complete: true,
    candidate_newly_observed: name === unknownArm
      ? { status: "unknown" as const, value: null, reason: "terminal_native_failure" }
      : { status: "known" as const, value: false, reason: "candidate_not_observed_in_second_round" } }));
  expect(compareCandidateDiscovery(arms)).toEqual({ status: "unknown", value: null,
    reason: `${unknownArm}_terminal_native_failure` });
});

it("keeps missing arms unknown and observed baseline sufficiency a known negative comparison", () => {
  const arms = ARMS.map(({ name }) => ({ arm: name, candidate_explicitly_observed_initially: name !== "C",
    initial_observed_identities_complete: true,
    candidate_newly_observed: { status: "known" as const, value: name === "C", reason: "observed" } }));
  expect(compareCandidateDiscovery(arms.slice(0, 2)))
    .toEqual({ status: "unknown", value: null, reason: "missing_arm_C" });
  expect(compareCandidateDiscovery(arms)).toEqual({ status: "known", value: false, reason: "A_also_observed_candidate" });
});

it.each(["skipped", "complete_absent"] as const)("keeps omitted initial baseline identities unknown when its second round is %s", secondState => {
  const complete = { terminal: false,
    identities: observationIdentitySummary(accessReceipt(["s-1"]), accessReceipt(["s-1"], 1, true)) };
  const omitted = { terminal: false,
    identities: observationIdentitySummary(accessReceipt(["s-1"], 2), accessReceipt(["s-1"], 2, true)) };
  const present = { terminal: false,
    identities: observationIdentitySummary(accessReceipt(["candidate"]), accessReceipt(["candidate"], 1, true)) };
  const arms = ARMS.map(({ name }) => ({ arm: name, candidate_explicitly_observed_initially: false,
    initial_observed_identities_complete: name === "C",
    candidate_newly_observed: name === "C" ? candidateDiscovery(complete, present)
      : candidateDiscovery(omitted, secondState === "skipped" ? undefined : complete) }));
  expect(arms.map(row => row.candidate_newly_observed.value)).toEqual([false, false, true]);
  expect(compareCandidateDiscovery(arms)).toEqual({ status: "unknown", value: null,
    reason: "A_initial_observed_identities_omitted" });
});

it("labels ordinary tests unbound and admits only an exact supplied implementation revision", () => {
  expect(executionBinding(undefined)).toEqual({ implementation_revision: null, execution_kind: "unbound_test" });
  const revision = "a".repeat(40);
  expect(executionBinding(revision)).toEqual({ implementation_revision: revision, execution_kind: "bound_experiment" });
  for (const invalid of ["", "main", "a".repeat(39), "a".repeat(41), "g".repeat(40)]) {
    expect(() => executionBinding(invalid)).toThrow("exact 40-hex revision");
  }
});
