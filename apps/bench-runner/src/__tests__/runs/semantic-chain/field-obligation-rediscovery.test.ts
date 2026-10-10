import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, expect, it, vi } from "vitest";
import { SoulInterpretationRequestSchema, SourceSemanticWorkerWorkSchema, sourceSemanticQueryIdentity,
  type SoulInterpretationRequest, type SoulInterpretationResponse, type SourceSemanticCorrespondence,
  type SourceSemanticWorkerWork } from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import { createSourceSemanticInterpretationHandler } from "../../../../../core-daemon/src/mcp-memory/tool/interpretation-handler.js";
import { CLOCK, WS, withAccessLibrary, type AccessFixtureSetup } from
  "../../../../../core-daemon/src/__tests__/runtime/recall/source-semantic-access.test-support.js";
import * as workerClient from "../../../../../core-daemon/src/runtime/recall/recall-read-worker-client.js";
import { decodeEngineBindings, oracleBindingsMatchEngine, oracleNecessaryLeavesHeld, oracleProofsMatchEngine,
  oracleSourceSemanticJoin } from "../../../../../../packages/core/src/__tests__/recall/runtime/source-semantic-relational-oracle.js";
import { chainIdentity } from "../../../runs/semantic-chain/contract.js";
import { freezeRecoveryAllowance, recordRecoveryNativeWork, reserveRecoveryAction, reserveRecoveryHostEffect,
  reserveRecoveryRead } from "../../../runs/semantic-chain/recovery-allowance.js";
import { recordSourceSemanticLibraryFirstExposure } from "../../../runs/measurement/source-semantic-library-recall.js";
import { measureSourceSemanticLibraryResponse } from "../../../runs/measurement/source-semantic-library-measurement.js";
import { ALLOWANCE, ARMS, BUDGETS, CASES, ORIGINAL_QUERY, QUERY, SCHEDULE, allowanceLedger,
  readHealthyManifest, correspondence, executionBinding, expectedBindings, finiteReference, fixtureSources,
  initialObservations, selectAction, selectFinalDescriptor, sourceActions, boundedFixtureSources, boundedSourceIds,
  sourceBatchCompletion, compareBoundedAccess,
  type Action, type Arm, type Decision, type Descriptor, type Fixture, type Preparation, type Delivery,
  type SourcePreparation } from "./field-obligation-rediscovery.test-support.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const scopes = { mode: "named" as const, scopes: ["project"] };
type Handler = ReturnType<typeof createSourceSemanticInterpretationHandler>;
type Failure = { status: "reservation_refused" | "terminal_native_error"; message: string; actual_work: SourceSemanticWorkerWork | "unknown" };
type Invocation = { name: string; request: SoulInterpretationRequest; response?: SoulInterpretationResponse;
  failure?: Failure; elapsed_ms: number; encoded_response_bytes: number | null };
type Round = { source?: SourcePreparation; prepare?: Preparation; delivery?: Delivery; calls: Invocation[];
  terminal: boolean; budget: typeof BUDGETS.common };
type Manifest = ReturnType<typeof readHealthyManifest>;

async function call(root: string, name: string, request: SoulInterpretationRequest, handler: Handler): Promise<Invocation> {
  const start = performance.now();
  const result: Invocation = { name, request, elapsed_ms: 0, encoded_response_bytes: null };
  const budget = request.budget;
  if (budget === undefined) throw new Error("native experiment requests require the frozen explicit budget");
  try { reserveRecoveryAction(root, name, chainIdentity(request), budget.work_units, budget.memory_bytes, false); }
  catch (error) { return { ...result, failure: { status: "reservation_refused", message: String(error), actual_work: "unknown" } }; }
  try {
    result.response = await handler(request, { workspaceId: WS, runId: "field-rediscovery", agentTarget: "codex", sessionId: root });
    recordRecoveryNativeWork(root, name, result.response.work);
    result.encoded_response_bytes = Buffer.byteLength(JSON.stringify(result.response));
  } catch (error) {
    const details = error !== null && typeof error === "object" && "details" in error ? error.details as { work?: unknown } : undefined;
    const work = SourceSemanticWorkerWorkSchema.safeParse(details?.work);
    if (work.success) recordRecoveryNativeWork(root, name, work.data);
    result.failure = { status: "terminal_native_error", message: String(error), actual_work: work.success ? work.data : "unknown" };
  }
  result.elapsed_ms = performance.now() - start;
  return result;
}

async function observe(root: string, name: "initial" | "second", handler: Handler,
  budget: typeof BUDGETS.common, options: { access_hint?: string; initial_source_id?: string } = {}): Promise<Round> {
  const round: Round = { calls: [], terminal: true, budget };
  if (name === "initial") {
    if (options.initial_source_id === undefined) throw new Error("the known initial source must be declared before access");
    const source = await call(root, "known-initial-source", SoulInterpretationRequestSchema.parse({ operation: "prepare_source",
      source_id: options.initial_source_id, authorized_scopes: scopes, budget }), handler);
    round.calls.push(source);
    if (source.response?.operation !== "prepare_source") return round;
    round.source = source.response;
    if (source.response.source_handle === undefined) return round;
  }
  const prepare = SoulInterpretationRequestSchema.parse({ operation: "prepare_query", original_query: ORIGINAL_QUERY,
    query_semantics: QUERY, authorized_scopes: scopes, budget,
    ...(round.source?.source_handle === undefined ? {} : { source_handle: round.source.source_handle }),
    ...(options.access_hint === undefined ? {} : { access_hint: options.access_hint }) });
  const first = await call(root, `${name}-prepare`, prepare, handler); round.calls.push(first);
  if (first.response?.operation !== "prepare_query") return round;
  round.prepare = first.response;
  if (first.response.query_handle === undefined || first.response.outcome !== undefined) return round;
  const second = await call(root, `${name}-delivery`, SoulInterpretationRequestSchema.parse({ operation: "recall",
    accepts_unreviewed_conditional_results: true, query_handle: first.response.query_handle,
    semantic_correspondences: [], authorized_scopes: scopes, budget, output_byte_limit: 1_000_000 }), handler);
  round.calls.push(second);
  if (second.response?.operation !== "recall") return round;
  round.delivery = second.response; round.terminal = false;
  return round;
}
function observations(round: Round) {
  return initialObservations([round.prepare?.access, round.delivery?.discovery?.access]);
}
function reason(root: string, name: string, descriptor: Descriptor, c: SourceSemanticCorrespondence, handler: Handler) {
  return call(root, name, SoulInterpretationRequestSchema.parse({ operation: "reason", accepts_unreviewed_conditional_results: true,
    original_query: ORIGINAL_QUERY, query_semantics: QUERY, source_interpretation_id: descriptor.interpretation_id,
    semantic_correspondence: c, authorized_scopes: scopes, budget: BUDGETS.reasoning, output_byte_limit: 1_000_000 }), handler);
}

function describeRound(round: Round | undefined) {
  if (round === undefined) return null;
  const exposure = round.delivery?.index === undefined ? null : recordSourceSemanticLibraryFirstExposure(round.delivery);
  return { ...round, observed_identities: observations(round), first_exposure: exposure,
    measurements: exposure === null ? null : measureSourceSemanticLibraryResponse({ recallResult: round.delivery,
      firstExposurePage: exposure, requestBudget: round.budget, goldSourceUnits: [] }),
    any_at_5: "unavailable_no_independent_gold_units" };
}

function oracleCheck(fixture: Fixture, descriptor: Descriptor, c: SourceSemanticCorrespondence, invocation?: Invocation) {
  const h = descriptor.interpretation!;
  const oracle = oracleSourceSemanticJoin(h, QUERY, c);
  const expected = expectedBindings(fixture, h);
  expect(oracle.assignments.map(row => row.bindings)).toEqual(expected);
  const result = invocation?.response?.operation === "reason" ? invocation.response.result : undefined;
  if (result?.binding_results === undefined) return { oracle, expected, status: "actual_bindings_unavailable", actual: null };
  const decoded = decodeEngineBindings(result);
  return { oracle, expected, status: "compared", actual: decoded,
    exact_assignments: oracleBindingsMatchEngine(oracle, decoded, QUERY.return_variables),
    exact_proof_leaves: oracleProofsMatchEngine(oracle, result),
    necessary_leaves: oracleNecessaryLeavesHeld(oracle, result.consumed_leaves) };
}

function describeGains(initial: Round, second: Round | undefined, arm: Arm,
  initialProof: ReturnType<typeof oracleCheck> | null, finalProof: ReturnType<typeof oracleCheck> | null) {
  const rawKey = (row: NonNullable<Delivery["results"]>[number]) => JSON.stringify({ target: row.target, text: row.content_preview });
  const priorRaw = new Set((initial.delivery?.results ?? []).map(rawKey));
  const priorH = new Set(initial.prepare?.candidates.map(row => row.interpretation_id) ?? []);
  const observed = observations(initial), priorSources = new Set(observed.read_sources.map(row => row.source_id));
  const bindingKey = (binding: Readonly<Record<string, string>>) => JSON.stringify(QUERY.return_variables.map(id => [id, binding[id]]));
  const before = arm === "F" ? initialProof?.actual : initialProof?.expected;
  const after = finalProof?.actual, priorBindings = new Set(before?.map(bindingKey));
  return { newly_observed_sources: observed.complete && second !== undefined && !second.terminal
      ? observations(second).read_sources.filter(row => !priorSources.has(row.source_id)) : null,
    newly_delivered_raw: (second?.delivery?.results ?? []).flatMap((row, index) => priorRaw.has(rawKey(row)) ? [] : [{ ...row,
      qualifiers: second!.delivery!.slot_qualifiers?.filter(qualifier => qualifier.index === index) ?? [] }]),
    newly_delivered_H: second?.prepare?.candidates.filter(row => !priorH.has(row.interpretation_id)) ?? [],
    conditional_bindings: { status: before == null || after == null ? "unknown" : "compared",
      initial_basis: arm === "F" ? "actual_initial_Field_result" : "independent_initial_source_reference_Field_unexercised",
      initial: before ?? null, final: after ?? null,
      gained: before == null || after == null ? null : after.filter(binding => !priorBindings.has(bindingKey(binding))),
      conclusion_scope: "conditional_on_authored_interpretations", world_claim: "unknown" } };
}

/** Destructive projections exercise the adapter; the unchanged actual response remains separately retained. */
function adapterControls(invocation: Invocation | undefined, descriptor: Descriptor | undefined,
  c: SourceSemanticCorrespondence | undefined, candidates: Action[], decision: Decision | undefined) {
  const result = invocation?.response?.operation === "reason" ? invocation.response.result : undefined;
  if (result?.attention?.kind !== "computed" || descriptor === undefined || c === undefined || decision?.selected == null) return null;
  return { kind: "adapter_input_corruption_controls", native_observations_added: 0,
    omitted: selectAction(undefined, descriptor, c, candidates).status,
    empty: selectAction(result, descriptor, c, []).status,
    duplicate: selectAction(result, descriptor, c, [...candidates, decision.selected]).status,
    unmatched: selectAction(result, descriptor, c, candidates.filter(row => row.frame !== decision.selected!.frame)).status,
    stale_source: selectAction(result, { ...descriptor, source_version: "stale-control" }, c, candidates).status,
    truncated: selectAction({ ...result, attention: { ...result.attention, truncated: true } }, descriptor, c, candidates).status,
    later_unobserved: selectAction({ ...result, attention: { ...result.attention,
      entries: result.attention.entries.map(entry => ({ ...entry, state: "unobserved", observation: "unknown" })) } },
    descriptor, c, candidates).status };
}

async function runArm(root: string, fixture: Fixture, arm: Arm, handler: Handler, manifest: Manifest, candidates: Action[], bounded = false) {
  const initialSourceId = bounded ? boundedSourceIds(fixture)[0]! : `${fixture.name}/initial`;
  const initial = await observe(root, "initial", handler, BUDGETS.common, { initial_source_id: initialSourceId });
  const initiallyObserved = observations(initial), initialIds = new Set(initiallyObserved.read_sources.map(row => row.source_id));
  const initialH = initial.prepare?.candidates.find(row => row.source_id === initialSourceId && row.interpretation !== undefined);
  const initialRecord = manifest.sources.find(row => row.source_id === initialSourceId)!;
  const rawInitialDelivered = initial.delivery?.results?.some(row => row.target.kind === "source_evidence"
    && row.target.root_id === initialRecord.record_id && row.content_preview === initialRecord.source_body) === true;
  const initialReady = !initial.terminal && initiallyObserved.complete && initialH !== undefined && initialIds.has(initialH.source_id)
    && initial.source?.source_id === initialSourceId && rawInitialDelivered
    && initial.prepare?.query_semantics_id === sourceSemanticQueryIdentity(QUERY, fieldContractSha256);
  let initialReason: Invocation | undefined, finalReason: Invocation | undefined, second: Round | undefined;
  let decision: Decision | undefined, selectedHint: string | undefined, stop = "initial_source_or_complete_receipts_unavailable";
  let finalH: Descriptor | undefined, finalC: SourceSemanticCorrespondence | undefined;
  const initialC = initialH === undefined ? undefined : correspondence(initialH);
  if (initialReady && initialH !== undefined) {
    if (arm === "F") initialReason = await reason(root, "initial-reason", initialH, initialC!, handler);
    reserveRecoveryRead(root, "source-bound candidate input and attention selection");
    if (arm === "F") decision = selectAction(initialReason?.response?.operation === "reason" ? initialReason.response.result : undefined,
      initialH, initialC!, candidates);
    selectedHint = arm === "B" ? "consignment shipment sent dispatched inspection inspected examined"
      : arm === "M" ? candidates[0]!.access_hint : decision?.selected?.access_hint;
    stop = arm === "F" && decision?.selected === null ? decision.status : "one_optional_access";
    console.info("FIELD_REDISCOVERY_DECISION " + JSON.stringify({ fixture: fixture.name, arm, candidates,
      initial_reason: initialReason ?? null, decision: decision ?? null, selected_hint: selectedHint ?? null }));
    if (arm !== "F" || decision?.selected !== null) {
      second = await observe(root, "second", handler, arm === "F" ? BUDGETS.common : BUDGETS.baseline,
        selectedHint === undefined ? {} : { access_hint: selectedHint });
      if (!second.terminal) finalH = selectFinalDescriptor(second.prepare?.candidates ?? [], initialH.interpretation_id);
      if (finalH !== undefined) {
        reserveRecoveryAction(root, "returned-H-correspondence", chainIdentity(finalH), 50_000, 2_000_000, false);
        finalC = correspondence(finalH);
        finalReason = await reason(root, "final-reason", finalH, finalC, handler);
        stop = finalReason.failure === undefined ? "final_conditional_reason_returned" : finalReason.failure.status;
      } else stop = second.terminal ? "terminal_second_access" : "no_new_eligible_H_returned";
    }
  }
  reserveRecoveryRead(root, "final receipt and semantic assessment");
  const initialProof = initialH === undefined || initialC === undefined ? null : oracleCheck(fixture, initialH, initialC, initialReason);
  const finalProof = finalH === undefined || finalC === undefined ? null : oracleCheck(fixture, finalH, finalC, finalReason);
  const controls = adapterControls(initialReason, initialH, initialC, candidates, decision);
  const secondObserved = second === undefined ? undefined : observations(second);
  const discovery = finalH === undefined ? { status: "unknown", reason: stop, newly_observed: null }
    : !initiallyObserved.complete || initial.terminal ? { status: "unknown", reason: "initial_receipts_incomplete", newly_observed: null }
    : secondObserved?.read_sources.some(row => row.source_id === finalH!.source_id)
      ? { status: "known", reason: initialIds.has(finalH.source_id) ? "final_H_source_was_already_receipt_visible"
        : "final_H_source_new_to_public_receipts", newly_observed: !initialIds.has(finalH.source_id) }
      : { status: "unknown", reason: "final_H_has_no_explicit_second_body_read", newly_observed: null };
  reserveRecoveryHostEffect(root, "result-output", chainIdentity({ fixture: fixture.name, arm }), false);
  const ledger = allowanceLedger(join(root, "recovery-allowance.sqlite"));
  const calls = [...initial.calls, ...(initialReason === undefined ? [] : [initialReason]), ...(second?.calls ?? []),
    ...(finalReason === undefined ? [] : [finalReason])];
  return { arm, stop, initial_source_id: initialSourceId, selected_hint: selectedHint ?? null, decision: decision ?? null, adapter_controls: controls,
    readiness: { initial: initialReady, initial_raw_delivered: rawInitialDelivered,
      field_selection: arm === "F" ? decision?.selected == null ? "unready" : "ready" : "not_exercised",
      initial_bindings: arm === "F" ? initialProof?.status === "compared" ? "compared" : "unknown" : "not_exercised",
      final_bindings: finalProof?.status === "compared" ? "compared" : "unknown" },
    access_boundary: { ...sourceBatchCompletion(manifest.sources, [second?.prepare?.access, second?.delivery?.discovery?.access]),
      returned_navigation_H: second?.prepare?.candidates.filter(row => manifest.sources.slice(-2).some(source => source.source_id === row.source_id)) ?? [],
      physical_first_read_novelty: "unknown_no_worker_IO_trace", receipt_visibility_is_not_physical_IO: true },
    initial: describeRound(initial),
    initial_correspondence: initialC ?? null, initial_reason: initialReason ?? null, initial_proof: initialProof,
    second: describeRound(second), final_H: finalH ?? null, final_correspondence: finalC ?? null,
    final_reason: finalReason ?? null, final_proof: finalProof, discovery,
    gains: describeGains(initial, second, arm, initialProof, finalProof),
    delivered_sources: (second?.delivery?.results ?? []).map((row, index) => {
      const target = row.target;
      return { ...row, source_id: target.kind === "source_evidence"
        ? manifest.sources.find(source => source.record_id === target.root_id)?.source_id ?? null : null,
      qualifiers: second!.delivery!.slot_qualifiers?.filter(qualifier => qualifier.index === index) ?? [] };
    }),
    allowance: ledger, native_calls: calls.length,
    measured_native_subtotal: ledger.actual_native.reduce((sum, row) => ({ native_work: sum.native_work + row.work.native_work,
      native_bytes: sum.native_bytes + row.work.native_bytes, logical_work: sum.logical_work + (row.work.logical_work ?? row.work.native_work),
      logical_memory_bytes: sum.logical_memory_bytes + row.work.logical_memory_bytes }),
    { native_work: 0, native_bytes: 0, logical_work: 0, logical_memory_bytes: 0 }),
    native_subtotal_complete: calls.every(row => row.failure === undefined),
    encoded_response_bytes: calls.reduce((sum, row) => sum + (row.encoded_response_bytes ?? 0), 0),
    setup_actual_cost: "unknown", semantic_input_authoring_actual_cost: "unknown", total_lifecycle_cost: "unknown",
    consumer_accuracy: "not_exercised", consumer_cost: "not_exercised",
    catalog: bounded ? "healthy_authored_bounded_population" : "healthy_authored_three_source_fixture" };
}

function checkReport(fixture: Fixture, report: Awaited<ReturnType<typeof runArm>>, bounded = false) {
  expect(report.allowance.work_reserved).toBeLessThanOrEqual(ALLOWANCE.total_work_units);
  expect(report.allowance.memory_reserved).toBeLessThanOrEqual(ALLOWANCE.total_memory_bytes);
  if (!bounded) {
    expect(report.initial?.prepare?.candidates.some(row => row.source_id === report.initial_source_id)).toBe(true);
    expect(report.final_reason?.response?.operation).toBe("reason");
  }
  for (const round of [report.initial, report.second]) if (round !== null) {
    if (round.prepare?.query_semantics_id !== undefined) expect(round.prepare.query_semantics_id).toBe(sourceSemanticQueryIdentity(QUERY, fieldContractSha256));
    for (const invocation of round.calls) if (invocation.response !== undefined) expect(invocation.response.provider_attempts).toBe(0);
    if (round.delivery !== undefined) {
      expect(round.delivery.proofs ?? []).toEqual([]);
      expect(round.delivery.coverage.conditional_computation).toBe("unexercised");
      expect(Buffer.byteLength(JSON.stringify(round.delivery))).toBeLessThanOrEqual(1_000_000);
    }
  }
  if (report.arm === "F" && (!bounded || report.decision?.selected != null)) {
    expect(report.decision?.status).toBe("covered_reported_pair");
    expect(report.selected_hint).toBe(fixture.expected_hint);
    expect(report.adapter_controls).toMatchObject({ omitted: "feedback_omitted", empty: "no_unique_action",
      duplicate: "no_unique_action", unmatched: "no_unique_action", stale_source: "reported_but_ineligible",
      truncated: "feedback_truncated", later_unobserved: "reported_but_ineligible" });
  }
  const requiredProofs = report.arm === "F" ? [report.final_proof, report.initial_proof] : [report.final_proof];
  for (const [index, proof] of requiredProofs.entries()) {
    const phase = index === 0 ? "final" : "initial";
    if (bounded && proof?.status !== "compared") {
      expect(phase === "final" ? report.readiness.final_bindings : report.readiness.initial_bindings).toBe("unknown");
      expect(proof?.actual ?? null).toBeNull();
      continue;
    }
    checkComparedProof(proof, `${report.arm} ${phase}`);
  }
  if (fixture.name === "split-item" && (!bounded || report.final_proof?.status === "compared")) expect(report.final_proof!.actual).toEqual([]);
}

function checkComparedProof(proof: ReturnType<typeof oracleCheck> | null, phase: string) {
  expect(proof?.status, `${phase} proof must compare actual bindings`).toBe("compared");
  expect(proof?.exact_assignments).toBe(true); expect(proof?.exact_proof_leaves).toBe(true); expect(proof?.necessary_leaves).toBe(true);
}

/** Corrupt only captured native output; absent bindings must not pass as an empty result. */
function checkMissingBindingsRejected(fixture: Fixture, report: Awaited<ReturnType<typeof runArm>>, bounded = false) {
  const phases = report.arm === "F" ? ["final", "initial"] as const : ["final"] as const;
  for (const phase of phases) {
    const invocation = phase === "final" ? report.final_reason : report.initial_reason;
    const response = invocation?.response;
    const descriptor = phase === "final" ? report.final_H
      : report.initial?.prepare?.candidates.find(row => row.source_id === report.initial_source_id);
    const c = phase === "final" ? report.final_correspondence : report.initial_correspondence;
    if (bounded && (response?.operation !== "reason" || response.result?.binding_results === undefined)) continue;
    if (invocation === null || response?.operation !== "reason" || descriptor == null || c === null) {
      throw new Error("missing-binding controls require an actual captured reasoning response and its H/C");
    }
    if (response.result === undefined || !("binding_results" in response.result)) {
      throw new Error("captured reasoning response must include actual bindings");
    }
    const { binding_results: removedBindings, ...withoutBindings } = response.result;
    expect(removedBindings).toBeDefined();
    const corrupted: Invocation = { ...invocation, response: { ...response, result: withoutBindings } };
    const proof = oracleCheck(fixture, descriptor, c, corrupted);
    expect(proof.status).toBe("actual_bindings_unavailable");
    expect(proof.actual).toBeNull();
    const corruptedReport = phase === "final" ? { ...report, final_reason: corrupted, final_proof: proof }
      : { ...report, initial_reason: corrupted, initial_proof: proof };
    if (bounded) {
      expect(proof.actual).not.toEqual([]);
      expect(() => checkComparedProof(proof, `${report.arm} ${phase}`)).toThrow(`${report.arm} ${phase} proof must compare actual bindings`);
    } else expect(() => checkReport(fixture, corruptedReport)).toThrow(`${report.arm} ${phase} proof must compare actual bindings`);
  }
}

function checkBoundedManifest(fixture: Fixture, manifest: Manifest) {
  const sources = boundedFixtureSources(fixture);
  expect(manifest.sources.map(row => row.source_id)).toEqual(boundedSourceIds(fixture));
  expect(manifest.sources.map(row => row.recorded_at)).toEqual(sources.map(row => row.recordedAt));
  expect(manifest.sources.every(row => row.source_version === "1" && row.event_time === null && row.scope_class === "project")).toBe(true);
  expect(manifest.sources.slice(1, 32).every(row => Buffer.byteLength(row.source_body) === 243)).toBe(true);
  expect(manifest.capsule_metadata.map(row => row.created_at)).toEqual(sources.map(row => row.publicationAt));
  expect(manifest.capsule_metadata.every(row => row.lifecycle_state === "active")).toBe(true);
  for (const source of sources.slice(1, 32)) {
    const h = manifest.publications.find(row => row.interpretation.source.source_id === source.id)!.interpretation;
    expect(h.frames.map(frame => frame.id)).toEqual(["send"]);
    expect(h.mentions.some(row => row.text === "Inspection status remains unknown.")).toBe(true);
  }
  for (const [index, title] of fixture.hints.entries()) {
    const h = manifest.publications.find(row => row.interpretation.source.source_id === sources[32 + index]!.id)!.interpretation;
    const titleMention = h.mentions.find(row => row.text === title);
    expect(titleMention).toBeDefined();
    expect(h.gaps.some(gap => gap.kind === "uninterpreted_clause" && gap.affected_ids.includes(titleMention!.id))).toBe(true);
    expect(h.frames.flatMap(frame => frame.predicate_support.kind === "explicit" ? frame.predicate_support.mentions : [])).not.toContain(titleMention!.id);
  }
}

/** Omit captured extents while retaining an explicit budget stop; omission cannot locate exhaustion. */
function checkCapturedReceiptOmission(fixture: Fixture, reports: readonly Awaited<ReturnType<typeof runArm>>[]) {
  const f = reports.find(row => row.arm === "F"), prepare = f?.second?.prepare, access = prepare?.access;
  if (f === undefined || prepare === undefined || access === undefined) throw new Error("receipt controls require captured F preparation");
  const omitted = { ...access, source_candidates: [], stopping_reasons: ["budget" as const],
    trace: { ...access.trace, omitted_source_count: access.observed_source_count } };
  const boundary = sourceBatchCompletion(access.source_candidates, [omitted]);
  expect(boundary.first_batch_complete).toBeNull();
  const projected = reports.map(row => row.arm === "F" ? { ...row, delivered_sources: [], access_boundary: boundary,
    second: { terminal: false, prepare: { ...prepare, access: omitted } } } : { ...row, delivered_sources: [] });
  const comparison = compareBoundedAccess(fixture, projected);
  expect(comparison.arms.find(row => row.arm === "F")).toMatchObject({ field_first_batch_ready: null, second_budget_stopped: true });
  expect(comparison.status).not.toBe("unready_at_F_first_batch_cap");
  expect(compareBoundedAccess(fixture, projected.map(row => row.arm === "F" ? { ...row,
    access_boundary: { first_batch_complete: false } } : row)).status).toBe("unready_at_F_first_batch_cap");
}

async function runFixture(fixture: Fixture, bounded = false) {
  const execution = executionBinding(process.env.ALAYA_FIELD_REDISCOVERY_IMPLEMENTATION_REVISION);
  const directory = mkdtempSync(join(tmpdir(), "field-obligation-rediscovery-")); roots.push(directory);
  const sources = bounded ? boundedFixtureSources(fixture) : fixtureSources(fixture), input = join(directory, "frozen-input.json");
  const protocol = bounded ? "healthy_bounded_access_discriminator" : "healthy_known_initial_source";
  const initialSourceId = sources[0]!.id;
  writeFileSync(input, JSON.stringify({ protocol, fixture,
    sources: sources.map(({ authoredDraft: _draft, ...row }) => row),
    original_query: ORIGINAL_QUERY, query: QUERY, arms: ARMS, budgets: BUDGETS, schedule: SCHEDULE, allowance: ALLOWANCE, ...execution }));
  const reports: Awaited<ReturnType<typeof runArm>>[] = [];
  const setups: (AccessFixtureSetup & { arm: Arm; publication_usage: unknown })[] = [];
  for (const arm of ARMS) {
    const root = join(directory, arm);
    freezeRecoveryAllowance(root, chainIdentity({ fixture, arm, ...execution }), ALLOWANCE, input);
    reserveRecoveryRead(root, "common frozen input including the already available initial source");
    reserveRecoveryAction(root, "source-H-setup", chainIdentity(sources.map(source => source.text)), 200_000, 8_000_000, false);
    const start = performance.now();
    await withAccessLibrary(sources, async ({ execute, filename, ids, publicationUsage, setup }) => {
      reserveRecoveryRead(root, "native source and publication manifest", [filename]);
      const manifest = readHealthyManifest(filename), setupElapsed = performance.now() - start;
      reserveRecoveryAction(root, "frozen-Q-H-C-and-reference", chainIdentity({ query: QUERY, fixture }), 50_000, 2_000_000, false);
      const semantics = manifest.publications.map(row => ({ ...row, correspondence: correspondence(row) }));
      for (const row of semantics) expect(oracleSourceSemanticJoin(row.interpretation, QUERY, row.correspondence).assignments
        .map(assignment => assignment.bindings)).toEqual(expectedBindings(fixture, row.interpretation));
      const candidates = sourceActions(fixture, manifest.sources.find(source => source.source_id === initialSourceId)!);
      expect(manifest.sources.map(row => row.source_body)).toEqual(sources.map(row => row.text));
      expect([...ids.values()].flat()).toHaveLength(sources.length);
      setups.push({ arm, publication_usage: [...publicationUsage], ...setup });
      if (bounded) checkBoundedManifest(fixture, manifest);
      console.info("FIELD_REDISCOVERY_MANIFEST " + JSON.stringify({ fixture: fixture.name, arm, ...execution,
        protocol, conditioning: manifest.conditioning,
        sources: manifest.sources, semantics, capsule_metadata: manifest.capsule_metadata,
        known_initial_source_id: initialSourceId, query: QUERY, original_query: ORIGINAL_QUERY, candidates,
        finite_reference: finiteReference(fixture), budgets: BUDGETS, schedule: SCHEDULE, allowance: ALLOWANCE,
        worker_isolation: "fresh_database_and_worker_per_arm", setup_elapsed_ms: setupElapsed,
        setup: setups.at(-1), source_admission_and_authoring_actual_cost: "unknown",
        allowance_before_access: allowanceLedger(join(root, "recovery-allowance.sqlite")),
        setup_actual_native_work: "unknown", setup_reservation_is_accounting_charge: true }));
      const handler = createSourceSemanticInterpretationHandler({ now: () => CLOCK, sourceSemanticsPort: { execute } });
      reports.push(await runArm(root, fixture, arm, handler, manifest, candidates, bounded));
    }, bounded ? { publicationBudget: { work_units: 200_000, memory_bytes: 8_000_000 },
      onSetupExhausted: async ({ filename, ids, publicationUsage, setup }) => {
        reserveRecoveryRead(root, "partial source and publication manifest after setup exhaustion", [filename]);
        reserveRecoveryHostEffect(root, "result-output", chainIdentity({ fixture: fixture.name, arm }), false);
        setups.push({ arm, publication_usage: [...publicationUsage], ...setup });
        console.info("FIELD_REDISCOVERY_SETUP " + JSON.stringify({ fixture: fixture.name, arm, ...execution, protocol,
          setup: setups.at(-1), acknowledged_publications: [...ids], partial_manifest: readHealthyManifest(filename),
          allowance: allowanceLedger(join(root, "recovery-allowance.sqlite")), worker_started: false, native_access_calls: 0,
          source_admission_and_authoring_actual_cost: "unknown", total_lifecycle_cost: "unknown" }));
      } } : undefined);
    if (setups.at(-1)?.status === "resource_exhausted") break;
  }
  console.info("FIELD_REDISCOVERY_REPORT " + JSON.stringify({ fixture: fixture.name, ...execution, arms: reports,
    finite_reference: finiteReference(fixture), protocol, source_count: sources.length, setups,
    comparison: bounded ? compareBoundedAccess(fixture, reports) : null,
    native_provider_calls: 0, automatic_clue_generation: "not_exercised", natural_source_utility: "not_exercised",
    general_algorithm_acceptance: "not_claimed", independent_review_required_for_acceptance: true }));
  for (const report of reports) checkReport(fixture, report, bounded);
  for (const report of reports) checkMissingBindingsRejected(fixture, report, bounded);
  if (!bounded) checkCapturedReceiptOmission(fixture, reports);
}

it.each(CASES)("records healthy source-bound Field feedback and rediscovery without requiring a win: $name",
  fixture => runFixture(fixture), 120_000);
it.each(CASES)("records bounded healthy source access without requiring relative Field gain: $name",
  fixture => runFixture(fixture, true), 120_000);

it("stops shared publication setup before the next source and worker after aggregate exhaustion", async () => {
  const first = { id: "publication-first", text: "Cargo J9 was sent.", reading: "send", verbatim: true };
  let singleUsage: AccessFixtureSetup["known_publication_subtotal"] | undefined;
  await withAccessLibrary([first], async ({ setup }) => { singleUsage = setup.known_publication_subtotal; });
  const budget = { work_units: singleUsage!.work_units + 1, memory_bytes: singleUsage!.memory_bytes + 64 };
  const startWorker = vi.spyOn(workerClient, "createRecallReadWorkerClient"), body = vi.fn(async () => undefined);
  let partialObserved = false;
  try {
    const setup = await withAccessLibrary([first, { ...first, id: "publication-second" }, { ...first, id: "publication-last" }], body,
      { publicationBudget: budget, onSetupExhausted: async ({ filename, ids, publicationUsage, setup: partial }) => {
        partialObserved = true;
        const manifest = readHealthyManifest(filename);
        expect(manifest.sources.map(row => row.source_id)).toEqual([first.id, "publication-second"]);
        expect(manifest.publications).toHaveLength(1);
        expect(ids.get(first.id)).toHaveLength(1); expect(ids.get("publication-second")).toEqual([]);
        expect(publicationUsage.get(first.id)).toEqual([singleUsage]);
        const failedUsage = publicationUsage.get("publication-second")![0]!;
        expect(failedUsage.work_units).toBeGreaterThan(0);
        expect(partial.known_publication_subtotal).toEqual({ work_units: singleUsage!.work_units + failedUsage.work_units,
          memory_bytes: singleUsage!.memory_bytes + failedUsage.memory_bytes });
        expect(partial.known_publication_subtotal.work_units).toBeLessThanOrEqual(budget.work_units);
        expect(partial.known_publication_subtotal.memory_bytes).toBeLessThanOrEqual(budget.memory_bytes);
        expect(startWorker).not.toHaveBeenCalled();
      } });
    expect(partialObserved).toBe(true);
    expect(setup).toMatchObject({ status: "resource_exhausted", admitted_source_ids: [first.id, "publication-second"],
      exhausted: { source_id: "publication-second", publication_index: 0 } });
    expect(body).not.toHaveBeenCalled(); expect(startWorker).not.toHaveBeenCalled();
  } finally { startWorker.mockRestore(); }
}, 30_000);

it.each(["duplicate", "exhausted"] as const)("refuses %s reservations before native work", async kind => {
  const root = mkdtempSync(join(tmpdir(), "field-rediscovery-reservation-")); roots.push(root);
  freezeRecoveryAllowance(root, "reservation-control", ALLOWANCE, join(root, "input.json"));
  const request = SoulInterpretationRequestSchema.parse({ operation: "prepare_query", original_query: ORIGINAL_QUERY,
    query_semantics: QUERY, budget: BUDGETS.common, authorized_scopes: scopes });
  if (kind === "duplicate") reserveRecoveryAction(root, "initial-prepare", chainIdentity(request), 200_000, 4_000_000, false);
  else reserveRecoveryAction(root, "prior-effect", "prior", 1_900_000, 1_000, false);
  const handler = vi.fn<Handler>(), result = await call(root, "initial-prepare", request, handler);
  expect(result.failure?.status).toBe("reservation_refused"); expect(handler).not.toHaveBeenCalled();
});

it("keeps unbound tests distinct and rejects malformed experiment revisions before setup", () => {
  expect(executionBinding(undefined)).toEqual({ implementation_revision: null, execution_kind: "unbound_test" });
  expect(() => executionBinding("HEAD")).toThrow(/40 lowercase hex/u);
});
