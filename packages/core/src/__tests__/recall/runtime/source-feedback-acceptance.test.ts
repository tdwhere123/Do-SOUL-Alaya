import { afterEach, expect, it, vi } from "vitest";
import { buildSourceReferenceCatalog, SourceSemanticWorkerResultSchema, sourceSemanticInterpretationIdentity,
  type SourceSemanticWorkerResult } from "@do-soul/alaya-protocol";
import type { SourceFeedbackCorrespondenceAction, SourceFeedbackCorrespondenceResult } from "../../../recall/runtime/source-feedback-correspondence.js";
import { captureSourceFeedbackTerminalCause, createSourceFeedbackSession, type SourceFeedbackSessionInput } from "../../../recall/runtime/source-feedback-session.js";
import { projectSourceDisclosure } from "../../../recall/runtime/source-disclosure.js";
import { CoreError } from "../../../shared/errors.js";
import { fieldContractSha256 } from "../../../shared/field-hash.js";
import * as locations from "../../../memory/evidence-create/source-semantic-location.js";
import { BUDGET, CLOCK, deliveredProofFixture } from "./source-semantic-proof-fixture.js";

afterEach(() => { vi.restoreAllMocks(); });
const BODY = "Alice uses X. Bob uses Y.";
const WORK = { native_work: 7, index_work: 4, logical_work: 11, native_bytes: 40, logical_memory_bytes: 80, rss_bytes: 1000 };
const COVERAGE = { discovery: "complete", source_interpretation: "complete", query_semantics: "complete",
  semantic_correspondence: "complete", conditional_computation: "complete", payload: "complete" } as const;
function fixture() {
  const { proof, target } = deliveredProofFixture();
  const { original_query, source_record: _record, interpretation, query, semantic_correspondence, context, ...result } = proof;
  const root: SourceFeedbackSessionInput = { request_id: "root", parent_entitlement_id: "entitlement",
    workspace_id: "ws", source_id: interpretation.source.source_id, source_target: target, original_query,
    scope_identity: "caller/project", as_of: CLOCK, action_budget: BUDGET,
    budget: { ...BUDGET, work_units: 4 * BUDGET.work_units, memory_bytes: 4 * BUDGET.memory_bytes },
    seed: { kind: "reason", accepts_unreviewed_conditional_results: true, source_interpretation_id: proof.source_interpretation_id,
      original_query, query_semantics: query, semantic_correspondence, budget: BUDGET, output_byte_limit: 1_000_000 } };
  const source = { source_id: interpretation.source.source_id, source_version: interpretation.source.source_version,
    content_digest: interpretation.source.content_digest, attribution_context: interpretation.source.attribution_context,
    source_disclosure: projectSourceDisclosure({ material_kind: "original_body", evaluated_as_of: CLOCK }),
    catalog: buildSourceReferenceCatalog(fieldContractSha256(BODY), [{ assertion_id: 1, text: BODY }], fieldContractSha256),
    coverage: COVERAGE, work: WORK };
  const prepared = SourceSemanticWorkerResultSchema.parse({ kind: "prepare_source", ...source, source_handle: "source-handle" });
  const validated = SourceSemanticWorkerResultSchema.parse({ kind: "validate_source", ...source, source: BODY,
    assertion_locations: [{ assertion_id: 1, source_utf8_span: [0, Buffer.byteLength(BODY)] }] });
  const reason = SourceSemanticWorkerResultSchema.parse({ kind: "reason", result, interpretation, query, semantic_correspondence,
    context, coverage: COVERAGE, work: WORK,
    source_disclosure: projectSourceDisclosure({ material_kind: "interpretation", evaluated_as_of: CLOCK }) });
  return { root, prepared, validated, reason, interpretation };
}
function observe(session: ReturnType<typeof createSourceFeedbackSession>, result: SourceSemanticWorkerResult) {
  const next = session.next();
  if (next.status !== "action") throw new Error("reserved action required");
  expect(session.accept(next.action.action_id, { status: "observed", result })).toBe(true);
  return next.action.action_id;
}

it.each(["malformed", "operation_mismatch", "negative_work", "excess_work", "excess_memory", "unmeasured"] as const)(
  "retains the complete hold and does not book rejected %s result measurements", condition => {
    const h = fixture(), session = createSourceFeedbackSession(h.root);
    const result = structuredClone(condition === "operation_mismatch" ? h.validated : h.prepared);
    if (condition === "malformed") Object.assign(result, { source_handle: undefined });
    if (condition === "negative_work") Object.assign(result.work, { logical_work: -1 });
    if (condition === "excess_work") Object.assign(result.work, { logical_work: BUDGET.work_units + 1 });
    if (condition === "excess_memory") Object.assign(result.work, { logical_memory_bytes: BUDGET.memory_bytes + 1 });
    if (condition === "unmeasured") Object.assign(result.work, { logical_work: undefined });
    const actionId = observe(session, result);
    expect(session.finish()).toMatchObject({ status: "unknown", exposures: [],
      accounting: { logical_work: 0, logical_memory_bytes: 0, reserved_work: BUDGET.work_units, reserved_memory_bytes: BUDGET.memory_bytes } });
    expect(session.accept(actionId, { status: "observed", result: h.prepared })).toBe(false);
    expect(session.next()).toEqual({ status: "stopped" });
  }
);

it("rejects excessive failure measurements without spending or refunding the reservation", () => {
  const h = fixture(), session = createSourceFeedbackSession(h.root), next = session.next();
  if (next.status !== "action") throw new Error("reserved action required");
  session.accept(next.action.action_id, { status: "failed", work: { ...WORK, logical_work: BUDGET.work_units + 1 } });
  expect(session.finish()).toMatchObject({ status: "unknown", accounting: { logical_work: 0, logical_memory_bytes: 0,
    reserved_work: BUDGET.work_units, reserved_memory_bytes: BUDGET.memory_bytes } });
});

it("settles a valid matching measurement exactly once using its inclusive logical totals", () => {
  const h = fixture(), session = createSourceFeedbackSession(h.root);
  const actionId = observe(session, h.prepared);
  expect(session.accept(actionId, { status: "observed", result: h.prepared })).toBe(false);
  expect(session.finish().accounting).toMatchObject({ logical_work: 11, logical_memory_bytes: 80, reserved_work: 0, reserved_memory_bytes: 0 });
  expect(session.next().status).toBe("action");
  expect(session.finish().accounting.reserved_work).toBe(BUDGET.work_units);
});

it.each(["valid_empty", "validation_rejected", "unexpected_failure", "missing_semantic_leaf", "missing_derivation", "usable_binding"] as const)(
  "keeps %s location/projection behavior distinct rather than hiding failure as non-actionable output", condition => {
    const h = fixture(), session = createSourceFeedbackSession(h.root);
    // This control replaces only the existing location owner. It does not reimplement
    // its rules or claim source-currentness/native proof; the binding computation itself is real Core execution.
    const binder = vi.spyOn(locations, "bindSourceSemanticLocations");
    if (condition === "validation_rejected") binder.mockImplementation(() => { throw new CoreError("VALIDATION", "selected span is invalid"); });
    else if (condition === "unexpected_failure") binder.mockImplementation(() => { throw new Error("location dependency failed"); });
    else binder.mockReturnValue(h.interpretation);
    const reason = structuredClone(h.reason);
    if (reason.kind === "reason") {
      if (condition === "valid_empty") Object.assign(reason.result!, { binding_results: [] });
      if (condition === "missing_semantic_leaf") Object.assign(reason.result!, { evidence_leaves: reason.result!.evidence_leaves!.slice(1) });
      if (condition === "missing_derivation") Object.assign(reason.result!, { derivations: reason.result!.derivations!.slice(1) });
    }
    observe(session, h.prepared); observe(session, h.validated); observe(session, reason);
    expect(binder).toHaveBeenCalledTimes(1);
    expect(binder.mock.calls[0]?.[0].source).toBe(BODY);
    if (condition === "usable_binding") {
      const next = session.next();
      expect(next.status).toBe("action");
      if (next.status !== "action" || next.action.request.kind !== "prepare_query") throw new Error("usable binding must navigate");
      expect(next.action.request.access_hint).toBe("X");
    } else {
      expect(session.next()).toEqual({ status: "stopped" });
      expect(session.finish().status).toBe(condition === "unexpected_failure" ? "unknown" : "non_actionable");
      if (condition === "unexpected_failure") expect(session.finish().terminal_cause).toMatchObject({
        kind: "execution_error", name: "Error", message: "location dependency failed" });
      else expect(session.finish()).not.toHaveProperty("terminal_cause");
    }
  }
);

function discoveryFixture() {
  const h = fixture();
  vi.spyOn(locations, "bindSourceSemanticLocations").mockReturnValue(h.interpretation);
  const root = { ...h.root, correspondence_policy_id: "exact-cache-policy" };
  const session = createSourceFeedbackSession(root);
  observe(session, h.prepared); observe(session, h.validated); observe(session, h.reason);
  const interpretation = structuredClone(h.interpretation);
  Object.assign(interpretation.source, { source_id: "discovered", source_version: "2" });
  const id = sourceSemanticInterpretationIdentity(interpretation, fieldContractSha256);
  const discovery = SourceSemanticWorkerResultSchema.parse({ kind: "prepare_query", query_handle: "new-query-lease",
    query_semantics_id: h.reason.kind === "reason" ? h.reason.result!.query_semantics_id : undefined,
    query_semantics_status: { status: "admitted", query_semantics_id: h.reason.kind === "reason" ? h.reason.result!.query_semantics_id : "" },
    candidates: [{ interpretation_id: id, source_id: "discovered", source_version: "2",
      content_digest: interpretation.source.content_digest, producer_id: interpretation.producer_id,
      producer_version: interpretation.producer_version, contract_version: interpretation.contract_version, interpretation,
      source_disclosure: projectSourceDisclosure({ material_kind: "interpretation", evaluated_as_of: CLOCK }) }],
    truncated: true, coverage: { ...COVERAGE, discovery: "truncated" }, work: WORK });
  return { ...h, root, session, interpretation, id, discovery };
}
function preparationFixture() {
  const h = discoveryFixture(); observe(h.session, h.discovery);
  const next = h.session.next();
  if (next.status !== "action" || next.action.request.kind !== "prepare_correspondence") throw new Error("host action required");
  const action = next.action as SourceFeedbackCorrespondenceAction;
  const c = h.root.seed.semantic_correspondence!;
  const prepared: SourceFeedbackCorrespondenceResult = { action, status: "ready", work: WORK, new_dispatches: 0,
    historical_production: { status: "unknown" }, semantic_correspondence: { ...c, source_interpretation_id: h.id } };
  return { ...h, action, prepared };
}

it.each(["missing_lease", "missing_descriptor", "descriptor_id_only", "query_mismatch", "wrong_version", "wrong_digest", "wrong_identity"] as const)(
  "keeps %s discovery unavailable instead of fabricating a ready correspondence", condition => {
    const h = discoveryFixture(), discovery = structuredClone(h.discovery);
    if (discovery.kind !== "prepare_query") throw new Error("discovery required");
    if (condition === "missing_lease") Object.assign(discovery, { query_handle: undefined });
    if (condition === "query_mismatch") Object.assign(discovery, { query_semantics_id: `sha256:${"f".repeat(64)}` });
    if (condition === "missing_descriptor") Object.assign(discovery, { candidates: [] });
    if (condition === "descriptor_id_only") Object.assign(discovery.candidates[0]!, { interpretation: undefined });
    if (condition === "wrong_version") Object.assign(discovery.candidates[0]!, { source_version: "other" });
    if (condition === "wrong_digest") Object.assign(discovery.candidates[0]!, { content_digest: `sha256:${"f".repeat(64)}` });
    if (condition === "wrong_identity") Object.assign(discovery.candidates[0]!, { interpretation_id: `sha256:${"f".repeat(64)}` });
    observe(h.session, discovery);
    expect(h.session.next()).toEqual({ status: "stopped" });
    expect(h.session.finish().qualification).toMatchObject({ status: "unavailable",
      reason: condition.startsWith("wrong_") ? "descriptor_mismatch" : condition });
    expect(h.session.finish().exposures).toHaveLength(4);
  }
);

it.each(["seed_c", "parent", "exposure", "origin_action", "hint", "policy", "budget", "unmeasured", "unknown"] as const)(
  "rejects %s preparation without dispatching local reasoning or resetting its parent allowance", condition => {
    const h = preparationFixture(), result = structuredClone(h.prepared);
    if (condition === "seed_c" && result.status === "ready") Object.assign(result, { semantic_correspondence: h.root.seed.semantic_correspondence });
    if (condition === "parent") Object.assign(result.action, { parent_entitlement_id: "foreign-parent" });
    if (condition === "exposure") Object.assign(result.action.request, { origin_exposure_id: "foreign-exposure" });
    if (condition === "origin_action") Object.assign(result.action.request, { origin_action_id: "foreign-action" });
    if (condition === "hint") Object.assign(result.action.request, { access_hint: "Y" });
    if (condition === "policy") Object.assign(result.action.request, { policy_id: "foreign-policy" });
    if (condition === "budget") Object.assign(result.action.request.budget, { work_units: 1 });
    if (condition === "unmeasured") Object.assign(result, { work: undefined });
    if (condition === "unknown") Object.assign(result, { status: "unknown", reason: "unknown_cost" });
    const before = h.session.finish().accounting;
    expect(h.session.accept(h.action.action_id, { status: "prepared", result })).toBe(true);
    expect(h.session.accept(h.action.action_id, { status: "prepared", result: h.prepared })).toBe(false);
    expect(h.session.next()).toEqual({ status: "stopped" });
    if (condition === "seed_c") {
      expect(h.session.finish().qualification).toMatchObject({ status: "unavailable", reason: "correspondence_rejected" });
      expect(h.session.finish().accounting.logical_work).toBe(before.logical_work + WORK.logical_work);
    } else {
      expect(h.session.finish().status).toBe("unknown");
      expect(h.session.finish().accounting).toEqual(before);
    }
  }
);

it("reserves the host and subsequent native reason independently from the same parent, without replay credit", () => {
  const h = preparationFixture();
  expect(h.action.parent_entitlement_id).toBe(h.root.parent_entitlement_id);
  expect(h.action.request.origin_action_id).toBe(h.session.finish().exposures[3]!.action_id);
  expect(h.action.request.origin_exposure_id).toBe(h.session.finish().exposures[3]!.exposure_id);
  expect(h.session.accept(h.action.action_id, { status: "prepared", result: h.prepared })).toBe(true);
  const next = h.session.next();
  if (next.status !== "action" || next.action.request.kind !== "reason") throw new Error("local reason required");
  expect(next.action.parent_entitlement_id).toBe(h.root.parent_entitlement_id);
  expect(next.action.request).toMatchObject({ query_handle: "new-query-lease", source_interpretation_id: h.id,
    original_query: h.root.original_query, query_semantics: h.root.seed.query_semantics });
  expect(next.action.request.semantic_correspondence?.source_interpretation_id).not.toBe(h.root.seed.source_interpretation_id);
  expect(h.session.finish().exposures[3]!.result.coverage.discovery).toBe("truncated");
  h.session.stop("unknown");
  expect(h.session.finish().accounting.reserved_work).toBe(BUDGET.work_units);
  expect(h.session.next()).toEqual({ status: "stopped" });
  expect(h.session.finish().joint_assessment.status).toBe("not_lowered");
});

it("does not construct C if actual prior costs leave insufficient parent entitlement", () => {
  const h = discoveryFixture();
  const root = { ...h.root, budget: { ...h.root.budget,
    work_units: BUDGET.work_units + 4 * WORK.logical_work - 1 } };
  const session = createSourceFeedbackSession(root);
  for (const result of [h.prepared, h.validated, h.reason, h.discovery]) observe(session, result);
  expect(session.next()).toEqual({ status: "stopped" });
  expect(session.finish()).toMatchObject({ status: "budget_exhausted", preparations: [],
    accounting: { logical_work: 4 * WORK.logical_work, reserved_work: 0 } });
});

it("skips higher-ranked unrelated H and retains existing order among literal hint matches", () => {
  const h = discoveryFixture(), discovery = structuredClone(h.discovery);
  if (discovery.kind !== "prepare_query") throw new Error("discovery required");
  const target = discovery.candidates[0]!, unrelated = structuredClone(target), secondMatch = structuredClone(target);
  Object.assign(unrelated.interpretation!.source, { source_id: "X-only-in-metadata" });
  Object.assign(unrelated.interpretation!.mentions.find(row => row.text === "X")!, { text: "Q" });
  Object.assign(unrelated, { source_id: unrelated.interpretation!.source.source_id,
    interpretation_id: sourceSemanticInterpretationIdentity(unrelated.interpretation!, fieldContractSha256) });
  Object.assign(secondMatch.interpretation!.source, { source_id: "second-matching-source" });
  Object.assign(secondMatch, { source_id: secondMatch.interpretation!.source.source_id,
    interpretation_id: sourceSemanticInterpretationIdentity(secondMatch.interpretation!, fieldContractSha256) });
  Object.assign(discovery, { candidates: [unrelated, target, secondMatch] });
  observe(h.session, discovery);
  const next = h.session.next();
  if (next.status !== "action" || next.action.request.kind !== "prepare_correspondence") throw new Error("hint-matched host action required");
  expect(next.action.request.descriptor.interpretation_id).toBe(target.interpretation_id);
  expect(next.action.request.access_hint).toBe("X");
});

it("uses the reserved navigation hint, not a caller-rewritten action or off-page interpretation", () => {
  const h = discoveryFixture(), discovery = structuredClone(h.discovery);
  if (discovery.kind !== "prepare_query") throw new Error("discovery required");
  const unrelated = structuredClone(discovery.candidates[0]!);
  Object.assign(unrelated.interpretation!.mentions.find(row => row.text === "X")!, { text: "Q" });
  Object.assign(unrelated, { interpretation_id: sourceSemanticInterpretationIdentity(unrelated.interpretation!, fieldContractSha256) });
  Object.assign(discovery, { candidates: [unrelated], truncated: true });
  const navigation = h.session.next();
  if (navigation.status !== "action" || navigation.action.request.kind !== "prepare_query") throw new Error("reserved navigation required");
  Object.assign(navigation.action.request, { access_hint: "Q" });
  h.session.accept(navigation.action.action_id, { status: "observed", result: discovery });
  expect(h.session.next()).toEqual({ status: "stopped" });
  expect(h.session.finish()).toMatchObject({ status: "complete", preparations: [],
    qualification: { status: "unavailable", reason: "hint_descriptor_not_exposed" } });
});

function qualifyingReasonFixture() {
  const h = preparationFixture();
  h.session.accept(h.action.action_id, { status: "prepared", result: h.prepared });
  const next = h.session.next();
  if (next.status !== "action" || next.action.request.kind !== "reason") throw new Error("qualifying reason required");
  return { ...h, reasonAction: next.action };
}

it.each(["filtered", "expired", "unavailable"] as const)("terminalizes measured %s qualifying-reason failure with its cause", admission => {
  const h = qualifyingReasonFixture(), before = h.session.finish().accounting;
  const cause = captureSourceFeedbackTerminalCause(new CoreError("VALIDATION", `native admission: ${admission}`,
    { details: { admission } }), "execution_error");
  h.session.accept(h.reasonAction.action_id, { status: "failed", work: WORK, terminal_cause: cause });
  expect(h.session.finish()).toMatchObject({ status: "failed", qualification: { status: "unavailable", reason: "reason_failed",
    terminal_cause: { kind: "execution_error", reason: { details: { admission } } } },
    accounting: { logical_work: before.logical_work + WORK.logical_work, reserved_work: 0, reserved_memory_bytes: 0 } });
  expect(h.session.next()).toEqual({ status: "stopped" });
});

it.each(["unmeasured_failure", "unknown", "cancelled"] as const)("keeps %s qualifying reason unknown with its reservation held", condition => {
  const h = qualifyingReasonFixture(), before = h.session.finish().accounting;
  const cause = captureSourceFeedbackTerminalCause(new Error(condition), condition === "cancelled" ? "caller_abort" : "execution_error");
  h.session.accept(h.reasonAction.action_id, condition === "unmeasured_failure" ? { status: "failed", terminal_cause: cause }
    : condition === "unknown" ? { status: "unknown", phase: "dispatched", terminal_cause: cause }
    : { status: "cancelled", terminal_cause: cause });
  expect(h.session.finish()).toMatchObject({ status: condition === "cancelled" ? "cancelled" : "unknown",
    qualification: { status: "unknown", terminal_cause: cause }, accounting: before });
  expect(h.session.accept(h.reasonAction.action_id, { status: "failed", work: WORK })).toBe(false);
  expect(h.session.next()).toEqual({ status: "stopped" });
});

it("terminalizes successful qualifying reason as local without another navigation", () => {
  const h = qualifyingReasonFixture();
  if (h.prepared.status !== "ready") throw new Error("new correspondence required");
  const { proof } = deliveredProofFixture({ interpretation: h.interpretation, semantics: h.root.seed.query_semantics,
    correspondence: h.prepared.semantic_correspondence, original: h.root.original_query });
  const { original_query: _original, source_record: _source, interpretation, query, semantic_correspondence, context, ...result } = proof;
  const local = SourceSemanticWorkerResultSchema.parse({ kind: "reason", interpretation, query, semantic_correspondence, context,
    result, work: WORK, coverage: COVERAGE,
    source_disclosure: projectSourceDisclosure({ material_kind: "interpretation", evaluated_as_of: CLOCK }) });
  h.session.accept(h.reasonAction.action_id, { status: "observed", result: local });
  expect(h.session.next()).toEqual({ status: "stopped" });
  expect(h.session.finish()).toMatchObject({ status: "complete", qualification: { status: "local" } });
  expect(h.session.finish().exposures).toHaveLength(5);
  expect(h.session.finish().joint_assessment.status).toBe("not_lowered");
});
