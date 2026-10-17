import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); });
afterAll(() => { isolation.restore(); });
import { createSourceFeedbackSession, type SourceFeedbackSessionInput } from "@do-soul/alaya-core";
import type { SourceSemanticWorkerResult } from "@do-soul/alaya-protocol";
import { executeSourceFeedback } from "../../../runtime/recall/source-feedback-execution.js";
import { CHILD, CONTEXT, ORIGINAL, query, withFeedbackSource, type Reason } from "./source-feedback.test-support.js";

function replay(sessionInput: SourceFeedbackSessionInput, results: readonly SourceSemanticWorkerResult[]) {
  const session = createSourceFeedbackSession(sessionInput);
  for (const result of results) {
    const next = session.next();
    if (next.status !== "action") throw new Error("reserved native action required");
    session.accept(next.action.action_id, { status: "observed", result });
  }
  return session;
}

it.each(["AP-42", "AP-73"])("derives %s from an actual M7 accepting binding and discovers approval outside the original native pool", async ticket => {
  await withFeedbackSource(ticket, async ({ client, session, native }) => {
    const port = client.sourceSemanticsPort!;
    const plain = await port.execute({ ...CONTEXT, request: { kind: "prepare_query", original_query: ORIGINAL,
      query_semantics: query(), budget: CHILD } });
    if (plain.kind !== "prepare_query") throw new Error("native preparation required");
    expect(plain.access?.source_candidates.map(row => row.source_id)).not.toContain("z");
    expect(native.result?.binding_results?.[0]?.bindings.actor).toMatchObject({ node_id: "rM7" });
    expect(native.result?.binding_results?.[0]?.returned.ticket).toMatchObject({ node_id: "rTicket" });
    expect(native.interpretation?.mentions.find(row => row.id === "mTicket")).toMatchObject({ text: ticket,
      utf8_span: [8, 13], span_space: "source_utf8" });
    const trace = await executeSourceFeedback({ session, context: CONTEXT, port, timeoutMs: 20_000 });
    expect(trace.status).toBe("complete");
    expect(trace.exposures.map(row => row.result.kind)).toEqual(["prepare_source", "validate_source", "reason", "prepare_query"]);
    const reason = trace.exposures[2]!.result, discovery = trace.exposures[3]!.result;
    if (reason.kind !== "reason" || discovery.kind !== "prepare_query") throw new Error("binding and fresh discovery required");
    expect(reason.result?.conditional_computation_id).toBe(native.result?.conditional_computation_id);
    expect(discovery.access?.source_candidates.map(row => row.source_id)).toContain("z");
    expect(discovery.access?.pool_id).not.toBe(plain.access?.pool_id);
    expect(discovery.query_semantics_id).toBe(plain.query_semantics_id);
    expect(discovery.access?.source_candidates.find(row => row.source_id === "z")).toMatchObject({ complete: true });
    expect(trace.joint_assessment.status).toBe("not_lowered");
    const nativeWork = trace.exposures.reduce((sum, row) => sum + row.result.work.logical_work!, 0);
    expect(trace.accounting.logical_work).toBe(nativeWork);
    expect(trace.accounting.logical_memory_bytes).toBe(trace.exposures.reduce((sum, row) => sum + row.result.work.logical_memory_bytes, 0));
    expect(trace.accounting.reserved_work).toBe(0);

    const local = replay(session, trace.exposures.slice(0, 3).map(row => row.result));
    const next = local.next();
    if (next.status !== "action" || next.action.request.kind !== "prepare_query") throw new Error("fresh navigation required");
    expect(next.action.request.original_query).toBe(ORIGINAL);
    expect(next.action.request.access_hint).toBe(ticket);
    expect(next.action.request).not.toHaveProperty("source_handle");
    expect(next.action.request).not.toHaveProperty("continuation_handle");
    expect(next.action.parent_entitlement_id).toBe(session.parent_entitlement_id);

    const before = trace.exposures.slice(0, 2).map(row => row.result);
    const nonActionable = (changed: Reason) => {
      const control = replay(session, [...before, changed]);
      expect(control.next()).toEqual({ status: "stopped" });
      expect(control.finish().status).toBe("non_actionable");
    };
    const change = (mutate: (value: Reason) => void) => {
      const value = structuredClone(reason); mutate(value); nonActionable(value);
    };
    change(value => { Object.assign(value.context!, { lowering_version: "wrong-context" }); });
    change(value => { Object.assign(value.result!.source_target!, { source_version: "other-version" }); });
    change(value => { Object.assign(value.result!.source_target!, { root_id: "other-source" }); });
    change(value => { Object.assign(value.result!, { derivations: [] }); });
    change(value => { Object.assign(value.result!, { evidence_leaves: [] }); });
    change(value => { Object.assign(value.coverage, { payload: "truncated" }); });
    change(value => { Object.assign(value, { result: undefined,
      interpretation: undefined, query: undefined, semantic_correspondence: undefined, context: undefined,
      no_conclusion: [reason.result!.outcome, [reason.result!.source_interpretation_id!, reason.result!.query_semantics_id!,
        reason.result!.semantic_correspondence_id!, reason.result!.conditional_computation_id!]] }); });
    change(value => { Object.assign(value.result!.binding_results![0]!, { binding_id: "@binding:sha256:unresolved", bindings: {}, returned: {} }); });
    const rejected = await port.execute({ ...CONTEXT, request: { ...session.seed,
      query_semantics: { ...query(), producer_id: "unregistered-query-producer" } } });
    if (rejected.kind !== "reason") throw new Error("native reason expected");
    expect(rejected.result?.outcome.status).toBe("invalid");
    nonActionable(rejected);

    // Decoded accepting coordinates remain usable without optional attention or parsing the opaque binding ID.
    const absentAttention = structuredClone(reason);
    Object.assign(absentAttention.result!, { attention: undefined });
    expect(replay(session, [...before, absentAttention]).next().status).toBe("action");
    // Same semantic result under another opaque binding alias cannot manufacture more native work.
    const duplicate = structuredClone(reason), binding = duplicate.result!.binding_results![0]!;
    Object.assign(duplicate.result!, { binding_results: [binding, { ...binding, binding_id: "another-opaque-attempt" }] });
    const coalesced = replay(session, [...before, duplicate]);
    const pending = coalesced.next();
    if (pending.status !== "action") throw new Error("navigation required");
    expect(coalesced.next()).toEqual({ status: "in_flight" });
    expect(coalesced.accept(pending.action.action_id, { status: "observed", result: discovery })).toBe(true);
    expect(coalesced.accept(pending.action.action_id, { status: "observed", result: discovery })).toBe(false);
    expect(coalesced.next()).toEqual({ status: "stopped" });
    expect(coalesced.finish().exposures).toHaveLength(4);
    expect(coalesced.finish().accounting.logical_work).toBe(nativeWork);
  });
}, 60_000);
