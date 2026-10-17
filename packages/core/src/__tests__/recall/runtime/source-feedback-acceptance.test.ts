import { afterEach, expect, it, vi } from "vitest";
import { buildSourceReferenceCatalog, SourceSemanticWorkerResultSchema, type SourceSemanticWorkerResult } from "@do-soul/alaya-protocol";
import { createSourceFeedbackSession, type SourceFeedbackSessionInput } from "../../../recall/runtime/source-feedback-session.js";
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
