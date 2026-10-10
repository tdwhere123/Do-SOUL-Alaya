import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  canonicalJson, SoulInterpretationRequestSchema, SourceSemanticWorkerWorkSchema, sourceSemanticQueryIdentity,
  type SoulInterpretationRequest, type SoulInterpretationResponse, type SourceSemanticWorkerWork
} from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import { createSourceSemanticInterpretationHandler } from "../../../../../core-daemon/src/mcp-memory/tool/interpretation-handler.js";
import { CLOCK, WS, withAccessLibrary, type AccessFixtureSetup, type PublicationBoundary } from
  "../../../../../core-daemon/src/__tests__/runtime/recall/source-semantic-access.test-support.js";
import { chainIdentity } from "../../../runs/semantic-chain/contract.js";
import { reserveRecoveryAction, reserveRecoveryHostEffect, reserveRecoveryRead, recordRecoveryNativeWork } from
  "../../../runs/semantic-chain/recovery-allowance.js";
import { allowanceLedger, initialObservations, readHealthyManifest, selectAction, type Decision, type Descriptor,
  type Preparation, type Delivery, type SourcePreparation } from "./field-obligation-rediscovery.test-support.js";
import { accessBudget, BASELINE_HINT, COMMON_BUDGET, KNOWN_INITIAL_SOURCE, nativeSources,
  ORIGINAL_QUERY, PUBLICATION_BUDGET, QUERY, REASON_BUDGET, SCOPES,
  type FrozenCell, type Slot } from "./field-feedback-acquisition-fixture.test-support.js";

type Handler = ReturnType<typeof createSourceSemanticInterpretationHandler>;
export type Invocation = { name: string; request: SoulInterpretationRequest; response?: SoulInterpretationResponse;
  error?: { message: string; code: string | null; sub_code: string | null; work: SourceSemanticWorkerWork | null };
  meter_error?: string;
  elapsed_ms: number; encoded_response_bytes: number | null; capture_complete: boolean };
export type NativeReport = {
  slot: Slot; status: "registered" | "setup_unready" | "observed" | "policy_unavailable" | "native_failure" | "not_run";
  stop: string; setup: AccessFixtureSetup | null; setup_elapsed_ms: number | null; native_started: boolean;
  manifest: ReturnType<typeof readHealthyManifest> | null;
  publication_receipts: { source_id: string; publication_index: number; status: string;
    usage: { work_units: number; memory_bytes: number } }[];
  common: { source?: SourcePreparation; prepare?: Preparation; delivery?: Delivery; initial_H?: Descriptor; ready: boolean };
  policy: { selected_hint: string | null; decision: Decision | null; reason?: Invocation;
    initial_bindings: "not_exercised" | "unknown" | "expected_empty" | "unexpected_nonempty" };
  access: { prepare?: Preparation; delivery?: Delivery };
  calls: Invocation[]; failure: string | null; protocol_contradiction: string | null;
  allowance: ReturnType<typeof allowanceLedger> | null;
};
export type CommonInput = Pick<FrozenCell, "cell" | "sources" | "query" | "initial_correspondence" | "actions">;

export function retainJson(root: string, name: string, value: unknown): void {
  writeFileSync(join(root, name), `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "wx", flush: true });
}

export class AcquisitionProtocolContradiction extends Error {}
function requireSame(actual: unknown, expected: unknown, label: string): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new AcquisitionProtocolContradiction(label);
}

export function emptyReport(slot: Slot): NativeReport {
  return { slot, status: "registered", stop: "registered_not_started", setup: null, setup_elapsed_ms: null,
    native_started: false, manifest: null, publication_receipts: [], common: { ready: false },
    policy: { selected_hint: null, decision: null, initial_bindings: "not_exercised" }, access: {}, calls: [], failure: null,
    protocol_contradiction: null, allowance: null };
}

function reserveNative(root: string, slot: Slot, name: string, budget: typeof COMMON_BUDGET): void {
  reserveRecoveryAction(root, name, chainIdentity({ slot: slot.id, name, budget }), budget.work_units, budget.memory_bytes, false);
}

/** The exclusive start file plus the allowance owner's reservation prohibit a second invocation. */
async function callNative(root: string, name: string, requestValue: unknown, handler: Handler, report: NativeReport) {
  const request = SoulInterpretationRequestSchema.parse(requestValue);
  retainJson(root, `call-${name}-started.json`, { name, request });
  const call: Invocation = { name, request, elapsed_ms: 0, encoded_response_bytes: null, capture_complete: false };
  report.calls.push(call);
  const start = performance.now();
  try {
    call.response = await handler(request, { workspaceId: WS, runId: "field-feedback-acquisition", agentTarget: "codex", sessionId: root });
    call.encoded_response_bytes = Buffer.byteLength(JSON.stringify(call.response));
    if (call.response.provider_attempts !== 0) throw new AcquisitionProtocolContradiction("provider attempt in native-only study");
    if (call.encoded_response_bytes > 1_000_000) throw new AcquisitionProtocolContradiction("native response exceeds frozen capture envelope");
  } catch (error) {
    const details = error !== null && typeof error === "object" && "details" in error ? error.details as { work?: unknown } : undefined;
    const work = SourceSemanticWorkerWorkSchema.safeParse(details?.work);
    call.error = { message: String(error), code: error !== null && typeof error === "object" && "code" in error ? String(error.code) : null,
      sub_code: error !== null && typeof error === "object" && "subCode" in error ? String(error.subCode) : null,
      work: work.success ? work.data : call.response?.work ?? null };
    if (error instanceof AcquisitionProtocolContradiction) report.protocol_contradiction = error.message;
  }
  call.elapsed_ms = performance.now() - start;
  const measured = call.response?.work ?? call.error?.work;
  if (measured !== undefined && measured !== null) {
    try { recordRecoveryNativeWork(root, name, measured); }
    catch (error) { call.meter_error = String(error); }
  }
  call.capture_complete = true;
  retainJson(root, `call-${name}.json`, call);
  if (report.protocol_contradiction !== null) throw new AcquisitionProtocolContradiction(report.protocol_contradiction);
  if (call.meter_error !== undefined) throw new Error(`native meter retention failed: ${call.meter_error}`);
  return call;
}

function capturedPublication(root: string, report: NativeReport, event: PublicationBoundary) {
  const stem = `publication-${event.source_id.split("/").at(-1)}-${event.publication_index}`;
  if (event.kind === "begin") {
    retainJson(root, `${stem}-started.json`, { source_id: event.source_id, publication_index: event.publication_index });
    return;
  }
  const receipt = { source_id: event.source_id, publication_index: event.publication_index,
    status: event.outcome.status, usage: event.usage };
  report.publication_receipts.push(receipt);
  retainJson(root, `${stem}.json`, { ...receipt, outcome: event.outcome.status === "published" ? event.outcome
    : { status: "failed", error: String(event.outcome.error) } });
}

function checkManifest(manifest: NonNullable<NativeReport["manifest"]>, frozen: CommonInput): void {
  requireSame(manifest.sources, frozen.sources.map(source => ({ source_id: source.source_id, record_id: source.record_id,
    source_version: source.source_version, content_digest: source.content_digest, source_body: source.text,
    recorded_at: source.recordedAt, event_time: null, scope_class: "project" })), "admitted source manifest differs from frozen bytes or order");
  requireSame(manifest.publications.map(row => ({ interpretation_id: row.interpretation_id, interpretation: row.interpretation })),
    frozen.sources.map(row => ({ interpretation_id: row.interpretation_id, interpretation: row.interpretation })),
    "published H differs from frozen authored interpretation");
  requireSame(manifest.capsule_metadata.map(row => ({ created_at: row.created_at, lifecycle_state: row.lifecycle_state })),
    frozen.sources.map(row => ({ created_at: row.publicationAt, lifecycle_state: "active" })),
    "publication clock or lifecycle differs from frozen sequence");
}

async function observeCommon(root: string, slot: Slot, handler: Handler, report: NativeReport, frozen: CommonInput) {
  for (const name of ["common-source", "common-prepare", "common-delivery"]) reserveNative(root, slot, name, COMMON_BUDGET);
  const source = await callNative(root, "common-source", { operation: "prepare_source", source_id: KNOWN_INITIAL_SOURCE,
    authorized_scopes: SCOPES, budget: COMMON_BUDGET }, handler, report);
  if (source.response?.operation !== "prepare_source" || source.error !== undefined) return;
  report.common.source = source.response;
  if (source.response.source_handle === undefined || source.response.outcome !== undefined) return;
  const prepare = await callNative(root, "common-prepare", { operation: "prepare_query", original_query: ORIGINAL_QUERY,
    query_semantics: QUERY, source_handle: source.response.source_handle, authorized_scopes: SCOPES, budget: COMMON_BUDGET }, handler, report);
  if (prepare.response?.operation !== "prepare_query" || prepare.error !== undefined) return;
  report.common.prepare = prepare.response;
  if (prepare.response.query_handle === undefined || prepare.response.outcome !== undefined) return;
  const delivery = await callNative(root, "common-delivery", { operation: "recall", accepts_unreviewed_conditional_results: true,
    query_handle: prepare.response.query_handle, semantic_correspondences: [], authorized_scopes: SCOPES,
    budget: COMMON_BUDGET, output_byte_limit: 1_000_000 }, handler, report);
  if (delivery.response?.operation !== "recall" || delivery.error !== undefined) return;
  report.common.delivery = delivery.response;
  const initial = frozen.sources[0]!;
  const h = prepare.response.candidates.find(row => row.source_id === KNOWN_INITIAL_SOURCE);
  if (h?.interpretation === undefined || delivery.response.results === undefined) return;
  requireSame(h.interpretation, initial.interpretation, "common public H differs from frozen H");
  requireSame(h.interpretation_id, initial.interpretation_id, "common public H identity differs");
  requireSame(prepare.response.query_semantics_id, sourceSemanticQueryIdentity(QUERY, fieldContractSha256), "common Q identity differs");
  const raw = delivery.response.results.findIndex(row => row.target.kind === "source_evidence"
    && row.target.root_id === initial.record_id && row.content_preview === initial.text);
  if (raw < 0 || !delivery.response.slot_qualifiers?.some(row => row.index === raw && row.evidence_kind === "source_evidence")) return;
  const observed = initialObservations([prepare.response.access, delivery.response.discovery?.access]);
  if (!observed.complete || !observed.read_sources.some(row => row.record_id === initial.record_id && row.complete)) return;
  report.common.initial_H = h;
  report.common.ready = true;
}

function reservePostFork(root: string, slot: Slot): void {
  if (slot.arm === "F") {
    reserveNative(root, slot, "feedback-reason", REASON_BUDGET);
    reserveRecoveryRead(root, "Field feedback read and retention");
  }
  reserveNative(root, slot, "access-prepare", accessBudget(slot));
  reserveNative(root, slot, "access-delivery", accessBudget(slot));
  reserveRecoveryRead(root, "assessment of complete public capture");
  reserveRecoveryHostEffect(root, "assessment-output", chainIdentity({ slot: slot.id, output: "immutable_report" }), false);
}

async function observePolicy(root: string, slot: Slot, handler: Handler, report: NativeReport, frozen: CommonInput) {
  reservePostFork(root, slot);
  if (slot.arm === "F") {
    const reason = await callNative(root, "feedback-reason", { operation: "reason", accepts_unreviewed_conditional_results: true,
      original_query: ORIGINAL_QUERY, query_semantics: QUERY, source_interpretation_id: report.common.initial_H!.interpretation_id,
      semantic_correspondence: frozen.initial_correspondence, authorized_scopes: SCOPES,
      budget: REASON_BUDGET, output_byte_limit: 1_000_000 }, handler, report);
    report.policy.reason = reason;
    const result = reason.response?.operation === "reason" ? reason.response.result : undefined;
    report.policy.initial_bindings = result?.binding_results === undefined || result.completeness?.logical_index !== "complete"
      || result.completeness.transport !== "complete" || result.completeness.payload !== "complete"
      || result.completeness.representation !== "complete" || result.attention?.kind === "computed" && result.attention.truncated
      ? "unknown" : result.binding_results.length === 0 ? "expected_empty" : "unexpected_nonempty";
    report.policy.decision = selectAction(result,
      report.common.initial_H!, frozen.initial_correspondence, frozen.actions, QUERY);
    if (reason.error !== undefined || report.policy.initial_bindings !== "expected_empty" || report.policy.decision.selected === null) {
      report.status = "policy_unavailable";
      report.stop = report.policy.initial_bindings === "expected_empty" ? report.policy.decision.status : `initial_bindings_${report.policy.initial_bindings}`;
      return;
    }
  }
  report.policy.selected_hint = slot.arm === "B" ? BASELINE_HINT : slot.arm === "M" ? frozen.actions[0]!.access_hint
    : report.policy.decision?.selected?.access_hint ?? null;
  retainJson(root, "selected-policy.json", { arm: slot.arm, ...report.policy });
  const budget = accessBudget(slot);
  const prepare = await callNative(root, "access-prepare", { operation: "prepare_query", original_query: ORIGINAL_QUERY,
    query_semantics: QUERY, authorized_scopes: SCOPES, budget,
    ...(report.policy.selected_hint === null ? {} : { access_hint: report.policy.selected_hint }) }, handler, report);
  if (prepare.response?.operation !== "prepare_query" || prepare.error !== undefined) {
    report.status = "native_failure"; report.stop = "access_preparation_failed"; return;
  }
  report.access.prepare = prepare.response;
  report.status = "observed";
  if (prepare.response.query_handle === undefined || prepare.response.outcome !== undefined) {
    report.stop = "bound_preparation_terminated"; return;
  }
  const delivery = await callNative(root, "access-delivery", { operation: "recall", accepts_unreviewed_conditional_results: true,
    query_handle: prepare.response.query_handle, semantic_correspondences: [], authorized_scopes: SCOPES,
    budget, output_byte_limit: 1_000_000 }, handler, report);
  if (delivery.response?.operation !== "recall" || delivery.error !== undefined) {
    report.status = "native_failure"; report.stop = "public_delivery_failed"; return;
  }
  report.access.delivery = delivery.response;
  report.stop = "public_raw_and_H_acquisition_complete";
}

/** The policy input has no sufficient-source identity or expected clue. Assessment receives those later. */
export async function runNativeSlot(root: string, report: NativeReport, frozen: CommonInput): Promise<NativeReport> {
  const slot = report.slot, start = performance.now();
  try {
    retainJson(root, "attempt-started.json", { slot });
    reserveRecoveryRead(root, "frozen common Q H C actions and source inputs");
    reserveRecoveryAction(root, "source-publication", chainIdentity(frozen.sources.map(row => row.text)),
      PUBLICATION_BUDGET.work_units, PUBLICATION_BUDGET.memory_bytes, false);
    report.native_started = true;
    await withAccessLibrary(nativeSources(slot.cell), async ({ execute, filename, setup, publicationUsage }) => {
      report.setup = setup; report.setup_elapsed_ms = performance.now() - start;
      reserveRecoveryRead(root, "actual native source and publication manifest", [filename]);
      report.manifest = readHealthyManifest(filename);
      retainJson(root, "common-native-setup.json", { setup, publication_usage: [...publicationUsage], manifest: report.manifest });
      checkManifest(report.manifest, frozen);
      reserveRecoveryAction(root, "frozen-semantics", chainIdentity({ query: QUERY, initial_C: frozen.initial_correspondence,
        actions: frozen.actions }), 50_000, 2_000_000, false);
      const handler = createSourceSemanticInterpretationHandler({ now: () => CLOCK, sourceSemanticsPort: { execute } });
      await observeCommon(root, slot, handler, report, frozen);
      retainJson(root, "common-public-setup.json", report.common);
      if (!report.common.ready) { report.status = "setup_unready"; report.stop = "common_public_setup_unready"; return; }
      await observePolicy(root, slot, handler, report, frozen);
    }, { publicationBudget: PUBLICATION_BUDGET,
      onPublicationBoundary: event => capturedPublication(root, report, event),
      onSetupExhausted: async ({ filename, setup, publicationUsage }) => {
        report.setup = setup; report.setup_elapsed_ms = performance.now() - start;
        reserveRecoveryRead(root, "partial native source and publication manifest", [filename]);
        report.manifest = readHealthyManifest(filename);
        report.status = "setup_unready"; report.stop = "publication_setup_exhausted";
        retainJson(root, "common-native-setup.json", { setup, publication_usage: [...publicationUsage], manifest: report.manifest });
      } });
  } catch (error) {
    report.failure = String(error);
    report.status = report.common.ready ? "native_failure" : "setup_unready";
    report.stop = "terminal_slot_exception";
    if (error instanceof AcquisitionProtocolContradiction) report.protocol_contradiction = error.message;
  }
  try { report.allowance = allowanceLedger(join(root, "recovery-allowance.sqlite")); }
  catch (error) { report.failure = `${report.failure ?? ""}; allowance capture failed: ${String(error)}`; }
  retainJson(root, "native-report.json", report);
  return report;
}
