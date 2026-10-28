import { afterAll, beforeAll, expect, it, vi } from "vitest";

const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});

import { cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { encodeSourceDisclosure, sourceDisclosure, SoulMemorySearchResponseSchema } from "@do-soul/alaya-protocol";
import { ordinaryIndexedSnapshot, simulateIndexedQueryPreparation } from "./ordinary-indexed-snapshot.test-support.js";
import { captureMultipleSources } from "./ordinary-multi-source.test-support.js";
import { admitOrdinaryRecallObservation } from "../../../runs/recall-measurement/ordinary/ordinary-recall.js";
import { readJson, writeJson, type RecallResponseCase } from "./ordinary-capture.test-support.js";
import { chainIdentity } from "../../../runs/recall-measurement/contract.js";
import { OrdinaryRecallMultiSourceConfigSchema, OrdinaryRecallMultiSourceObservationSchema } from "../../../runs/recall-measurement/ordinary/ordinary-recall-contract.js";
import { verifyOrdinaryMultiSourceDelivery } from "../../../runs/recall-measurement/ordinary/ordinary-multi-source-delivery.js";
import { FirstExposureSession } from "../../../runs/measurement/first-exposure-session.js";
import { capturedCalls } from "./ordinary-multi-source.test-support.js";
import { inspectOrdinaryRecallObservation } from "../../../runs/recall-measurement/ordinary/ordinary-recall.js";


let base: Awaited<ReturnType<typeof ordinaryIndexedSnapshot>>;
let capture: Awaited<ReturnType<typeof captureMultipleSources>>;
let largeBase: typeof base;
let emptyBase: typeof base;
let large: typeof capture;
let partial: typeof capture;
let failed: typeof capture;
let empty: typeof capture;
const stateCaptures = {} as Record<RecallResponseCase, typeof capture>;
beforeAll(async () => {
  simulateIndexedQueryPreparation();
  base = await ordinaryIndexedSnapshot([`Project Aster was mentioned. ${"Aster context. ".repeat(10)}`,
    `Project Birch was mentioned. ${"Birch context. ".repeat(12)}`]);
  capture = await captureMultipleSources(base, "complete");
  largeBase = await ordinaryIndexedSnapshot([`Project Aster was mentioned. ${"Aster context. ".repeat(250)}`,
    `Project Birch was mentioned. ${"Birch context. ".repeat(260)}`]);
  large = await captureMultipleSources(largeBase, "complete");
  partial = await captureMultipleSources(largeBase, "prefix");
  failed = await captureMultipleSources(largeBase, "prefix_error");
  emptyBase = await ordinaryIndexedSnapshot([]);
  empty = await captureMultipleSources(emptyBase, "complete");
  for (const state of ["invalidated", "resource_rejected", "interrupted", "open", "unknown", "transport_partial", "complete_empty"] as const) {
    stateCaptures[state] = await captureMultipleSources(emptyBase, "complete", state);
  }
  stateCaptures.indexed_without_preview = await captureMultipleSources(base, "complete", "indexed_without_preview");
}, 120000);
afterAll(() => {
  vi.restoreAllMocks();
  for (const fixture of [base, largeBase, emptyBase]) if (fixture !== undefined) rmSync(fixture.root, { recursive: true, force: true });
  isolation.restore(); expect(isolation.violations).toEqual([]);
});

it("admits actual multiple source roots and each contiguous targeted expansion from the same public query", () => {
  expect(capture.observation.source_states).toHaveLength(2);
  expect(capture.observation.source_states.every(source => source.source_complete)).toBe(true);
  expect(capture.delivered).toEqual(capture.bodies);
  const admitted = admitOrdinaryRecallObservation(capture.root);
  expect(admitted.state).toBe("complete");
  expect(admitted.binding).toMatchObject({ protocol_package_version: "29.0.0", reader_protocol_package_version: "29.0.0",
    public_semantics: "ordinary-native-field.v6", producer_revision: capture.config.implementation_revision });
  expect(capturedCalls(capture).every(call => call.output?.index?.result_version === "ordinary-native-field.v6")).toBe(true);
});

it("defers the second large source to a new membership page and expands both through issued payload continuations", () => {
  expect(large.observation.source_states).toHaveLength(2);
  expect(large.observation.source_states.every(source => source.source_complete)).toBe(true);
  expect(large.delivered).toEqual(large.bodies);
  expect(admitOrdinaryRecallObservation(large.root).state).toBe("complete");
  const calls = capturedCalls(large), initial = calls[0]!;
  expect(initial.output?.index?.entries).toHaveLength(1);
  expect(initial.output?.results).toHaveLength(1);
  const membership = calls.filter(call => call.request.phase === "membership");
  expect(membership).toHaveLength(2);
  expect(membership[1]!.output!.index!.entries).toHaveLength(1);
  expect(membership[1]!.output!.index!.entries[0]!.target).not.toEqual(initial.output!.index!.entries[0]!.target);
  expect(calls.filter(call => call.request.phase === "payload")
    .every(call => call.request.arguments.payload_continuation!.start_offset! > 0)).toBe(true);
  for (const call of calls) expect(call.firstExposure?.initial).toEqual(initial.firstExposure?.initial);
});

it("retains the historical single-source archive refusal for a real multi-source page", () => {
  const root = join(base.root, "legacy-multi-source"); cpSync(capture.root, root, { recursive: true });
  const first = capture.observation.source_states[0]!;
  const config = { ...capture.config, capture_contract: "ordinary-recall-local-capture-v1",
    expected_target: first.target, expected_source_bytes: first.contiguous_delivered_bytes };
  writeJson(join(root, "config.json"), config);
  for (const path of ["preparation.json", "execution/reservation.json"]) {
    writeJson(join(root, path), { ...readJson(join(root, path)), config_identity: chainIdentity(config) });
  }
  rmSync(join(root, "execution/observation.json")); rmSync(join(root, "execution/observation-final-state.json"));
  expect(() => admitOrdinaryRecallObservation(root)).toThrow("selected source population");
});

it("retains the delivered prefix without inventing membership for a deferred root, and preserves public errors", () => {
  const admitted = admitOrdinaryRecallObservation(partial.root);
  expect(admitted.state).toBe("partial");
  expect(admitted.sources).toHaveLength(1);
  expect(admitted.sources?.every(source => source.contiguous_delivered_bytes > 0)).toBe(true);
  expect(admitted.sources?.every(source => !source.source_complete)).toBe(true);
  expect(admitOrdinaryRecallObservation(failed.root).evidence.calls.at(-1)?.response_state).toBe("public_error");
  const unknown = join(largeBase.root, "unknown-capture"); cpSync(partial.root, unknown, { recursive: true });
  rmSync(join(unknown, "execution/process-result.json"));
  expect(inspectOrdinaryRecallObservation(unknown).state).toBe("unknown");
  expect(() => admitOrdinaryRecallObservation(unknown)).toThrow("closed ordinary Recall capture");
});

it("keeps the native empty source population unknown while its public interpretation remains open", () => {
  expect(empty.observation.source_states).toEqual([]);
  expect(capturedCalls(empty)[0]!.output!.index!.completeness).toMatchObject({
    logical_index: "open", observed_coverage: "exhausted_empty", interpretation_coverage: "open", transport: "open", payload: "open" });
  expect(inspectOrdinaryRecallObservation(empty.root).state).toBe("unknown");
  expect(() => admitOrdinaryRecallObservation(empty.root)).toThrow("successful public source exposure");
});

it("recognizes an authored complete-empty protocol control without claiming source exposure", () => {
  const control = stateCaptures.complete_empty;
  expect(capturedCalls(control)[0]!.output!.index!.completeness).toMatchObject({
    logical_index: "complete", observed_coverage: "exhausted_empty", transport: "complete", payload: "complete" });
  expect(inspectOrdinaryRecallObservation(control.root).state).toBe("empty");
  expect(() => admitOrdinaryRecallObservation(control.root)).toThrow("successful public source exposure");
});

it.each(["invalidated", "resource_rejected", "interrupted"] as const)("keeps zero-exposure %s public pages distinct from valid-empty membership", state => {
  const captured = stateCaptures[state], observation = inspectOrdinaryRecallObservation(captured.root);
  expect(observation.state).toBe("failed");
  expect(observation.evidence.calls[0]?.response_state).toBe("success");
  expect(observation.successfulExposures).toBe(0);
  expect(observation.sources).toEqual([]);
  expect(() => admitOrdinaryRecallObservation(captured.root)).toThrow("successful public source exposure");
});

it.each(["open", "unknown", "transport_partial", "indexed_without_preview"] as const)("keeps zero-exposure %s membership unknown", state => {
  const observation = inspectOrdinaryRecallObservation(stateCaptures[state].root);
  expect(observation.state).toBe("unknown");
  expect(observation.successfulExposures).toBe(0);
  expect(observation.sources).toHaveLength(state === "indexed_without_preview" ? 2 : 0);
  expect(observation.sources?.every(source => source.contiguous_delivered_bytes === 0 && !source.source_complete)).toBe(true);
});

it("shares payload and total call allowances across all indexed sources", () => {
  const config = OrdinaryRecallMultiSourceConfigSchema.parse(large.config), calls = capturedCalls(large);
  expect(large.observation.payload_expansion_calls).toBeGreaterThan(1);
  expect(() => verifyOrdinaryMultiSourceDelivery({ ...config, bounds: { ...config.bounds, payload_expansion_calls: 1 } },
    calls, undefined)).toThrow("shared call bound");
  expect(() => verifyOrdinaryMultiSourceDelivery({ ...config, bounds: { ...config.bounds, total_recall_calls: calls.length - 1 } },
    calls, undefined)).toThrow("shared call bound");
});

it("rejects a payload response for another indexed source instead of the requested source", () => {
  const calls = capturedCalls(large), first = calls[0]!;
  const requested = calls.find(call => call.request.phase === "payload")!;
  const target = requested.request.arguments.payload_continuation!.target;
  const other = calls.find(call => call.request.phase === "payload" &&
    call.request.arguments.payload_continuation!.target.kind === "source_evidence" && target.kind === "source_evidence" &&
    call.request.arguments.payload_continuation!.target.root_id !== target.root_id)!;
  expect(other).toBeDefined();
  const output = { ...requested.output!, index: { ...requested.output!.index!, entries: other.output!.index!.entries }, results: other.output!.results };
  const exposures = new FirstExposureSession(), initial = { ...first, firstExposure: exposures.record(first.output!) };
  const substituted = { ...requested, output, firstExposure: exposures.record(output, requested.request.arguments.continuation) };
  expect(() => verifyOrdinaryMultiSourceDelivery(OrdinaryRecallMultiSourceConfigSchema.parse(large.config),
    [initial, substituted], undefined)).toThrow("requested source member");
});

it.each(["invalidated", "resource_rejected", "interrupted"] as const)("retains prior source exposure when a structured payload page is %s", state => {
  const calls = capturedCalls(large), first = calls[0]!, requested = calls.find(call => call.request.phase === "payload")!;
  const output = SoulMemorySearchResponseSchema.parse({ ...requested.output, results: [], index: {
    ...requested.output!.index, entries: [], continuation: null, page_purpose: undefined, completeness: { ...requested.output!.index!.completeness,
      logical_index: state, payload: state } } });
  const exposures = new FirstExposureSession(), initial = { ...first, firstExposure: exposures.record(first.output!) };
  const terminalCall = { ...requested, output, firstExposure: exposures.record(output, requested.request.arguments.continuation) };
  const delivered = verifyOrdinaryMultiSourceDelivery(OrdinaryRecallMultiSourceConfigSchema.parse(large.config), [initial, terminalCall], undefined);
  expect(delivered.complete).toBe(false);
  expect(delivered.successfulExposures).toBe(1);
  expect(delivered.sources).toHaveLength(1);
});

it.each(["workspace", "digest", "disclosure", "source_state"] as const)("rejects changed multi-source %s evidence", field => {
  const calls = structuredClone(capturedCalls(capture));
  const observation = OrdinaryRecallMultiSourceObservationSchema.parse(structuredClone(capture.observation));
  const first = calls[0]!, row = first.output!.results[0]!;
  if (field === "source_state") observation.source_states[0]!.contiguous_delivered_bytes -= 1;
  else if (field === "disclosure") Object.assign(row, { source_disclosure: encodeSourceDisclosure({ ...sourceDisclosure(row.source_disclosure!), material_kind: "original_body" }) });
  else {
    const target = first.output!.index!.entries[0]!.target;
    if (target.kind !== "source_evidence") throw new Error("source fixture required");
    Object.assign(target, field === "workspace" ? { workspace_id: "foreign" } : { content_digest: `sha256:${"0".repeat(64)}` });
    Object.assign(row.target, target);
    const exposures = new FirstExposureSession(); first.firstExposure = exposures.record(first.output!);
  }
  expect(() => verifyOrdinaryMultiSourceDelivery(OrdinaryRecallMultiSourceConfigSchema.parse(capture.config), calls, observation)).toThrow();
});

