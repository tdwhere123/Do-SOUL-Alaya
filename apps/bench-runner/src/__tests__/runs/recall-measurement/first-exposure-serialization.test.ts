import { afterAll, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
import { createHash } from "node:crypto";
import { ContinuationSchema, SoulMemorySearchResponseSchema, stableCanonicalStringify, type Continuation } from "@do-soul/alaya-protocol";
import { exposureSlots, FirstExposurePageSchema, FirstExposureSession, firstExposureMismatch,
  initialScoringSlots, type FirstExposurePage } from "../../../runs/measurement/first-exposure-session.js";
import { verifyExposure } from "../../../runs/recall-measurement/ordinary/ordinary-recall-delivery.js";
import type { CapturedOrdinaryRecallCall } from "../../../runs/recall-measurement/ordinary/ordinary-recall.js";

afterAll(() => { isolation.restore(); expect(isolation.violations).toEqual([]); });
const clock = "2026-10-01T00:00:00.000Z";
const identity = { query_id: "query", snapshot_id: `sha256:${"a".repeat(64)}`, interpretation_id: "interpretation", as_of: clock };
const digest = (value: unknown) => createHash("sha256").update(stableCanonicalStringify(value)).digest("hex");
const archive = (page: FirstExposurePage) => FirstExposurePageSchema.parse(JSON.parse(JSON.stringify(page)));
function token(cursor = "next"): Continuation {
  return { schema_version: 1, continuation_id: cursor, query_id: identity.query_id, snapshot_id: identity.snapshot_id,
    result_version: "version", cursor, expires_at: "2099-01-01T00:00:00.000Z",
    interpretation_id: identity.interpretation_id, interpretation_clock: clock };
}
function response(delivery = "first", ids = ["memory"], continuation: Continuation | null = token()) {
  return structuredClone(SoulMemorySearchResponseSchema.parse({ delivery_id: delivery, results: ids.map(object_id => ({
    object_id, object_kind: "memory_entry", target: { kind: "memory_entry", workspace_id: "workspace", object_id, source_revision: "revision" },
    relevance_score: 0.5, content_preview: "Synthetic preview", evidence_pointers: [], selection_reason: "Synthetic",
    hypothesis_id: "hypothesis", output_binding: "binding", program_state: "accepting", time_state: "as_of",
    source_channels: [], score_factors: { activation: 0, relevance: 0 }, budget_state: {
      token_estimate: 1, max_entries: 5, max_total_tokens: 100, remaining_entries: 4, remaining_tokens: 99, within_budget: true }
  })), total_count: ids.length, index: { schema_version: 1, ...identity, result_version: "version", entries: [], continuation,
    completeness: { schema_version: 1, logical_index: "partial", observed_coverage: "partial", transport: "complete", payload: "complete", representation: "complete" },
    representation: { schema_version: 1, policy: "construct_index_then_page_then_payload", page_budget: 5, identity_tie_break: "serialization" },
    page_purpose: "membership" } }));
}
function expectBound(page: FirstExposurePage, output: ReturnType<typeof response>) {
  const { commitment, ...material } = page;
  expect(commitment).toBe(digest(material));
  const { digest: initialDigest, ...initialMaterial } = page.initial!;
  expect(initialDigest).toBe(digest(initialMaterial));
  expect(firstExposureMismatch(page, identity, exposureSlots(output), output.delivery_id)).toBe(false);
}

it("commits the serialized request semantics when an issued continuation has own undefined optional keys", () => {
  const issued = { ...token(), cap_contracts: undefined, claim_demands: undefined };
  const session = new FirstExposureSession(), first = response("first", ["memory"], issued);
  const initial = archive(session.record(first));
  // The actual MCP request has passed through JSON; the receipt must use the same identity.
  const requested: Continuation = JSON.parse(JSON.stringify(issued));
  const terminal = response("terminal", [], null), page = archive(session.record(terminal, requested));
  expect(page.initial).toEqual(initial.initial);
  expect(page.request_continuation).toEqual(requested);
  expectBound(page, terminal);
  const withUndefined = archive(session.record(terminal, issued));
  expect(withUndefined.initial).toEqual(initial.initial);
  expect(withUndefined.request_continuation).not.toHaveProperty("cap_contracts");
  expectBound(withUndefined, terminal);
  expect(Object.hasOwn(issued, "cap_contracts")).toBe(true);
  expect(Object.isFrozen(issued)).toBe(false);
});

it("captures detached initial targets, scoring slots and request continuation without freezing caller objects", () => {
  const session = new FirstExposureSession(), first = response();
  const scoring = exposureSlots(first).map(slot => ({ ...slot, fused_score: undefined, abstention_confidence_score: undefined }));
  const page = session.record(first, null, scoring), before = JSON.stringify(page);
  const target = first.results[0]!.target;
  expect(Object.isFrozen(target)).toBe(false);
  expect(Object.isFrozen(scoring[0])).toBe(false);
  if (target.kind !== "memory_entry") throw new Error("memory fixture required");
  Object.assign(target, { source_revision: "mutated-after-capture" });
  Object.assign(scoring[0]!, { relevance_score: 0.1 });
  expect(JSON.stringify(page)).toBe(before);
  expectBound(archive(page), response());
  const request = token(), later = response("later", [], null);
  const continued = session.record(later, request), captured = JSON.stringify(continued);
  expect(Object.isFrozen(request)).toBe(false);
  Object.assign(request, { cursor: "mutated-after-capture" });
  expect(JSON.stringify(continued)).toBe(captured);
  expectBound(archive(continued), later);
});

it("does not retain a live caller continuation after its commitment is issued", () => {
  const session = new FirstExposureSession(); session.record(response());
  const requested = token(), output = response("terminal", [], null);
  const page = session.record(output, requested), captured = JSON.stringify(page);
  expect(Object.isFrozen(requested)).toBe(false);
  Object.assign(requested, { cursor: "caller-changed-after-capture" });
  expect(requested.cursor).toBe("caller-changed-after-capture");
  expect(JSON.stringify(page)).toBe(captured);
  expectBound(archive(page), output);
});

it("preserves one initial digest through membership, empty terminal and retry pages", () => {
  const session = new FirstExposureSession(), first = response("first", ["memory"], token("one"));
  const initial = archive(session.record(first));
  const second = response("second", ["other"], { ...token("two"), cap_contracts: undefined, claim_demands: undefined });
  const next = archive(session.record(second, token("one")));
  const terminal = response("terminal", [], null);
  const last = archive(session.record(terminal, second.index!.continuation));
  const retry = response("first"); Object.assign(retry.index!, { page_purpose: "retry" });
  const repeated = archive(session.record(retry));
  for (const [page, output] of [[initial, first], [next, second], [last, terminal], [repeated, retry]] as const) {
    expect(page.initial).toEqual(initial.initial);
    expectBound(page, output);
    expect(initialScoringSlots({ ...output, first_exposure_page: page })).toEqual(initial.initial!.scoring_slots);
  }
  expect(last.page_purpose).toBe("membership");
  expect(last.commitment).toMatch(/^[a-f0-9]{64}$/u);
});

it.each([
  { label: "invalid optional number", patch: { protocol_version: NaN } },
  { label: "unknown undefined field", patch: { foreign_authority: undefined } },
  { label: "invalid null contracts", patch: { cap_contracts: null } },
  { label: "invalid nested claim", patch: { claim_demands: [{ variable: "v", proposition_kind: "p", argument_variables: [], required_claim: "invalid" }] } }
])("rejects $label before JSON can hide malformed requested or issued authority", ({ patch }) => {
  const malformed = { ...token(), ...patch };
  expect(ContinuationSchema.safeParse(malformed).success).toBe(false);
  const session = new FirstExposureSession();
  session.record(response());
  expect(() => session.record(response("later", [], null), malformed as Continuation)).toThrow();
  const invalidOutput = response("bad", [], null);
  Object.assign(invalidOutput.index!, { continuation: malformed });
  expect(() => session.record(invalidOutput)).toThrow();
  // Failed recording cannot seed a retry with a replacement initial.
  const retry = response("bad"); Object.assign(retry.index!, { page_purpose: "retry" });
  expect(session.record(retry).initial).toBeNull();
});

it("does not silently insert a default into captured continuation claim identity", () => {
  const raw = { ...token(), claim_demands: [{ variable: "v", proposition_kind: "p", argument_variables: [] }] };
  expect(ContinuationSchema.safeParse(raw).success).toBe(true);
  const session = new FirstExposureSession();
  const output = response("first", [], null); Object.assign(output.index!, { continuation: raw });
  expect(() => session.record(output)).toThrowError(expect.objectContaining({ code: "VALIDATION",
    message: "first-exposure material cannot be normalized during capture" }));
  expect(raw.claim_demands[0]).not.toHaveProperty("required_claim");
});

it("reports malformed responses and inconsistent exposure as distinct domain failures", () => {
  const output = response(), page = new FirstExposureSession().record(output);
  expect(() => initialScoringSlots({ ...output, results: null })).toThrowError(expect.objectContaining({ code: "VALIDATION",
    message: "conditional Recall response is invalid" }));
  expect(() => initialScoringSlots({ ...output, first_exposure_page: { ...page, commitment: "0".repeat(64) } }))
    .toThrowError(expect.objectContaining({ code: "CONFLICT", message: "conditional Recall first exposure unavailable or inconsistent" }));
});

it("rejects tampered commitment, initial identity and actual request binding without re-signing", () => {
  const session = new FirstExposureSession(), first = response();
  const initial = session.record(first), later = response("later", [], null), page = archive(session.record(later, token()));
  const call = { request: { arguments: { continuation: token() } }, output: later, firstExposure: page } as CapturedOrdinaryRecallCall;
  expect(() => verifyExposure(call, later.index!, initial)).not.toThrow();
  expect(firstExposureMismatch(page, { ...identity, query_id: "different-actual-query" }, exposureSlots(later), later.delivery_id)).toBe(true);
  expect(firstExposureMismatch(page, identity, exposureSlots(later), "different-actual-delivery")).toBe(true);
  for (const altered of [
    { ...page, commitment: "0".repeat(64) },
    { ...page, initial: { ...page.initial!, identity: { ...page.initial!.identity, query_id: "foreign" } } },
    { ...page, request_continuation: { ...page.request_continuation!, cursor: "foreign" } }
  ]) expect(() => verifyExposure({ ...call, firstExposure: altered }, later.index!, initial)).toThrow(/first-exposure/u);
  expect(() => verifyExposure({ ...call, request: { ...call.request,
    arguments: { ...call.request.arguments, continuation: { ...token(), cursor: "not-actually-requested" } } } }, later.index!, initial))
    .toThrow(/request binding changed/u);
});

it("keeps bounded delivery and issued caches without minting first exposure after eviction or in a fresh session", () => {
  const session = new FirstExposureSession();
  const first = session.record(response("first", ["memory"], token("old")));
  for (let n = 0; n < 256; n++) session.record(response(`delivery-${n}`, ["memory"], token(`token-${n}`)));
  const terminal = response("terminal", [], null);
  expect(session.record(terminal, token("old")).initial).toBeNull();
  expect(new FirstExposureSession().record(terminal, token("old")).initial).toBeNull();
  const retry = response("first"); Object.assign(retry.index!, { page_purpose: "retry" });
  expect(session.record(retry).initial).toBeNull();
  const retained = session.record(terminal, token("token-255"));
  expect(retained.initial).not.toBeNull();
  expect(retained.initial).not.toEqual(first.initial);
  expectBound(archive(retained), terminal);
});
