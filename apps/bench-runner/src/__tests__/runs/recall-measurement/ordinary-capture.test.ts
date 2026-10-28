import { afterAll, beforeAll, expect, it, vi } from "vitest";

const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});

import { cpSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { encodeSourceDisclosure, sourceDisclosure, SourceDisclosureSchema, SoulMemorySearchResponseSchema } from "@do-soul/alaya-protocol";
import { chainIdentity } from "../../../runs/recall-measurement/contract.js";
import { admitOrdinaryRecallObservation, inspectOrdinaryRecallObservation } from "../../../runs/recall-measurement/ordinary/ordinary-recall.js";
import { installedRecallProtocolVersion, OrdinaryRecallContextSchema, OrdinaryRecallEnvelopeSchema, OrdinaryRecallObservationSchema,
  OrdinaryRecallPreparationSchema, OrdinaryRecallRequestRecordSchema,
  OrdinaryRecallWireRecordSchema } from "../../../runs/recall-measurement/ordinary/ordinary-recall-contract.js";
import { FirstExposurePageSchema } from "../../../runs/measurement/first-exposure-session.js";
import { HIDDEN_GOLD, HIDDEN_SOURCE } from "./native-recall.test-support.js";
import { ordinaryIndexedSnapshot, simulateIndexedQueryPreparation } from "./ordinary-indexed-snapshot.test-support.js";
import { captureFailedCallFixture, captureOrdinaryFixture, readJson, writeJson } from "./ordinary-capture.test-support.js";
import { authorHistoricalOrdinaryCapture } from "./historical-ordinary-capture.test-support.js";

let base: Awaited<ReturnType<typeof ordinaryIndexedSnapshot>>;
const captures = {} as Record<"complete" | "prefix" | "prefix_error" | "error", Awaited<ReturnType<typeof captureOrdinaryFixture>>>;
beforeAll(async () => {
  simulateIndexedQueryPreparation();
  base = await ordinaryIndexedSnapshot([`Project Aster was mentioned. ${"Other project context. ".repeat(160)}${HIDDEN_SOURCE}`]);
  for (const mode of ["complete", "prefix", "prefix_error", "error"] as const) captures[mode] = await captureOrdinaryFixture(base, mode);
}, 120000);
afterAll(() => {
  vi.restoreAllMocks();
  if (base !== undefined) rmSync(base.root, { recursive: true, force: true });
  isolation.restore(); expect(isolation.violations).toEqual([]);
});

function authoredHistoricalCapture(name: string, protocolVersion: string) {
  return authorHistoricalOrdinaryCapture(captures.prefix, join(base.root, name), protocolVersion);
}

function rewriteCapturedEnvelope(root: string, ordinal: number,
  rewrite: (value: z.infer<typeof OrdinaryRecallEnvelopeSchema>) => z.infer<typeof OrdinaryRecallEnvelopeSchema>) {
  const path = join(root, "execution", `${String(ordinal).padStart(2, "0")}-public-envelope.json`);
  const envelope = rewrite(OrdinaryRecallEnvelopeSchema.parse(readJson(path))); writeJson(path, envelope);
  const wirePath = join(root, "execution/public-mcp-messages.jsonl");
  const wire = readFileSync(wirePath, "utf8").trimEnd().split("\n").map(line => OrdinaryRecallWireRecordSchema.parse(JSON.parse(line)));
  const reply = wire.filter(row => row.direction === "server_to_client" && row.message.result !== undefined)[ordinal - 1];
  expect(reply).toBeDefined(); reply!.message.result = envelope;
  writeFileSync(wirePath, `${wire.map(row => JSON.stringify(row)).join("\n")}\n`);
}

it.each(["complete", "prefix", "prefix_error"] as const)("readmits the exact ordered %s public envelopes without consumer execution", mode => {
  const capture = captures[mode], observation = admitOrdinaryRecallObservation(capture.root);
  expect(observation.state).toBe(mode === "complete" ? "complete" : "partial");
  expect(installedRecallProtocolVersion()).toBe("30.0.0");
  expect(observation.binding).toMatchObject({ protocol_package_version: "30.0.0", reader_protocol_package_version: "30.0.0",
    public_semantics: "ordinary-native-field.v7", producer_revision: capture.config.implementation_revision });
  expect(capture.config.first_request.enumeration_policy).toBe("native_query");
  expect(observation.evidence.calls.map(call => call.envelope)).toEqual(Array.from({ length: capture.observation.calls },
    (_, index) => readJson(join(capture.execution, `${String(index + 1).padStart(2, "0")}-public-envelope.json`))));
  expect(JSON.stringify(observation.evidence)).not.toContain(HIDDEN_GOLD);
  expect(JSON.stringify(observation.evidence).includes(HIDDEN_SOURCE)).toBe(mode === "complete");
  if (mode === "prefix_error") expect(observation.evidence.calls.at(-1)).toMatchObject({ response_state: "public_error" });
});

it.each(["14.1.0", "15.0.0", "16.0.0", "17.0.0", "18.0.0", "18.1.0", "19.0.0", "19.1.0", "20.0.0", "27.0.0", "28.0.0", "29.0.0"])("admits an authored %s format control without rewriting its declared provenance", protocolVersion => {
  const { root, config } = authoredHistoricalCapture(`authored-historical-${protocolVersion}`, protocolVersion);
  const original = readFileSync(join(root, "config.json"), "utf8");
  const originalEnvelope = readFileSync(join(root, "execution/01-public-envelope.json"), "utf8");
  const observation = admitOrdinaryRecallObservation(root);
  expect(observation.binding).toMatchObject({ protocol_package_version: protocolVersion, reader_protocol_package_version: "30.0.0",
    producer_candidate: config.candidate, producer_revision: config.implementation_revision });
  expect(observation.state).toBe("partial");
  expect(readFileSync(join(root, "config.json"), "utf8")).toBe(original);
  expect(readFileSync(join(root, "execution/01-public-envelope.json"), "utf8")).toBe(originalEnvelope);
});

it.each([
  ["27.0.0", "ordinary-native-field.v5"], ["27.0.0", "ordinary-native-field.v6"],
  ["28.0.0", "ordinary-native-field.v4"], ["28.0.0", "ordinary-native-field.v6"]
])("refuses an authored %s archive with another supported result identity %s", (version, resultVersion) => {
  const { root } = authoredHistoricalCapture(`cross-pair-${version}-${resultVersion}`, version);
  rewriteCapturedEnvelope(root, 1, envelope => {
    const payload = JSON.parse(String(envelope.content[0]!.text));
    payload.output.index.result_version = resultVersion;
    return { ...envelope, structuredContent: payload, content: [{ type: "text", text: JSON.stringify(payload) }] };
  });
  expect(() => admitOrdinaryRecallObservation(root)).toThrow("supported public contract");
});

it.each(["ordinary-native-field.v4", "ordinary-native-field.v5"])(
  "refuses a current native continuation carrying historical identity %s", resultVersion => {
    const root = join(base.root, `cross-pair-continuation-${resultVersion}`);
    cpSync(captures.prefix.root, root, { recursive: true });
    rewriteCapturedEnvelope(root, 1, envelope => {
      const payload = JSON.parse(String(envelope.content[0]!.text));
      payload.output.index.continuation.result_version = resultVersion;
      return { ...envelope, structuredContent: payload, content: [{ type: "text", text: JSON.stringify(payload) }] };
    });
    expect(() => admitOrdinaryRecallObservation(root)).toThrow("supported public contract");
  });

it.each(["18.0.0", "18.1.0", "19.0.0", "19.1.0", "20.0.0"])("refuses legacy original-body qualification relabeled as a %s capture", protocolVersion => {
  const { root, config } = authoredHistoricalCapture(`original-overclaim-${protocolVersion}`, "17.0.0");
  config.protocol_package_version = protocolVersion; writeJson(join(root, "config.json"), config);
  for (const path of ["preparation.json", "execution/reservation.json"]) {
    const value = readJson(join(root, path)); value.config_identity = chainIdentity(config); writeJson(join(root, path), value);
  }
  if (!["19.0.0", "19.1.0", "20.0.0"].includes(protocolVersion)) {
    expect(() => admitOrdinaryRecallObservation(root)).toThrow("public source qualifications differ from sealed metadata");
  } else expect(() => admitOrdinaryRecallObservation(root)).toThrow(z.ZodError);
});

it.each(["semantics", "enumeration"] as const)("refuses current producer with historical %s despite recomputed binding", field => {
  const root = join(base.root, `native-historical-${field}`); cpSync(captures.prefix.root, root, { recursive: true });
  const config = readJson(join(root, "config.json"));
  if (field === "semantics") config.public_semantics = "conditional-field-source-only-v1";
  else config.first_request.enumeration_policy = "canonical";
  writeJson(join(root, "config.json"), config);
  for (const path of ["preparation.json", "execution/reservation.json"]) {
    const value = readJson(join(root, path)); value.config_identity = chainIdentity(config); writeJson(join(root, path), value);
  }
  expect(() => admitOrdinaryRecallObservation(root)).toThrow("unsupported ordinary Recall producer");
});

it.each(["result_version", "continuation_version", "continuation_policy", "object_disclosure", "original_overclaim", "unknown_field"] as const)(
  "refuses current %s even when both public wire representations agree", field => {
    const root = join(base.root, `native-invalid-${field}`); cpSync(captures.prefix.root, root, { recursive: true });
    rewriteCapturedEnvelope(root, 1, envelope => {
      const payload = JSON.parse(String(envelope.content[0]!.text));
      const output = payload.output;
      if (field === "result_version") output.index.result_version = "ordinary-native-field.v3";
      else if (field === "continuation_version") output.index.continuation.result_version = "ordinary-native-field.v3";
      else if (field === "continuation_policy") output.index.continuation.enumeration_policy = "canonical";
      else if (field === "unknown_field") output.unreviewed_extra_field = true;
      else {
        const disclosure = sourceDisclosure(SourceDisclosureSchema.parse(output.results[0].source_disclosure));
        output.results[0].source_disclosure = field === "object_disclosure" ? disclosure
          : encodeSourceDisclosure({ ...disclosure, material_kind: "original_body" });
      }
      return { ...envelope, structuredContent: payload, content: [{ type: "text", text: JSON.stringify(payload) }] };
    });
    expect(() => admitOrdinaryRecallObservation(root)).toThrow(field === "original_overclaim"
      ? /qualifications differ/u : field === "object_disclosure" || field === "unknown_field"
        ? z.ZodError : /supported public contract/u);
  });

it("reports a terminal public error without claiming source exposure", () => {
  expect(inspectOrdinaryRecallObservation(captures.error.root)).toMatchObject({ state: "failed", successfulExposures: 0 });
  expect(() => admitOrdinaryRecallObservation(captures.error.root)).toThrow(/successful public source exposure/u);
});
it("keeps an unfinished reserved episode unknown and refuses readmission", () => {
  const root = join(base.root, "unknown-capture"); cpSync(captures.prefix.root, root, { recursive: true });
  unlinkSync(join(root, "execution/process-result.json"));
  expect(inspectOrdinaryRecallObservation(root)).toMatchObject({ state: "unknown", closed: false });
  expect(() => admitOrdinaryRecallObservation(root)).toThrow(/closed/u);
});

it.each([
  { name: "first call after handler entry", capture: "prefix", retainedContext: true, rpcError: false },
  { name: "first call before handler entry", capture: "prefix", retainedContext: false, rpcError: false },
  { name: "first RPC error after handler entry", capture: "prefix", retainedContext: true, rpcError: true },
  { name: "first RPC error before handler entry", capture: "prefix", retainedContext: false, rpcError: true },
  { name: "later call after handler entry", capture: "prefix_error", retainedContext: true, rpcError: false },
  { name: "later RPC error before handler entry", capture: "prefix_error", retainedContext: false, rpcError: true }
] as const)("preserves the producer summary when the $name never returns", ({ name, capture, ...options }) => {
  const run = captureFailedCallFixture(captures[capture], join(base.root, `failed-call-${name}`), options);
  const inspected = inspectOrdinaryRecallObservation(run.root), last = inspected.evidence.calls.at(-1)!;
  expect(inspected).toMatchObject({ state: "failed", closed: false, successfulExposures: capture === "prefix" ? 0 : 1 });
  expect(last).toMatchObject({ envelope: null, response_state: options.rpcError ? "transport_error" : "unknown" });
  expect(inspected.evidence.calls[0]!.envelope).toEqual(capture === "prefix" ? null
    : readJson(join(captures.prefix_error.execution, "01-public-envelope.json")));
  expect(() => admitOrdinaryRecallObservation(run.root)).toThrow(/closed/u);
  expect(readJson(join(run.execution, "observation-final-state.json"))).toEqual(run.observation);
});

it.each(["workspaceId", "runId"] as const)("checks retained %s even without a principal summary", key => {
  const run = captureFailedCallFixture(captures.prefix, join(base.root, `failed-call-${key}`), { retainedContext: true, rpcError: false });
  const path = join(run.execution, "01-trusted-contexts.json"), contexts = readJson(path); contexts[0][key] = "other"; writeJson(path, contexts);
  expect(() => inspectOrdinaryRecallObservation(run.root)).toThrow(/workspace or run/u);
});
it("rejects a principal summary conflicting with returned public-call context", () => {
  const run = captureFailedCallFixture(captures.prefix_error, join(base.root, "failed-call-conflicting-summary"), { retainedContext: true, rpcError: false });
  writeJson(join(run.execution, "observation-final-state.json"), { ...run.observation,
    trusted_principal: { ...OrdinaryRecallContextSchema.parse(run.observation.trusted_principal), sessionId: "other" } });
  expect(() => inspectOrdinaryRecallObservation(run.root)).toThrow(/trusted principal/u);
});
it("rejects a failed call context changing the previously returned principal", () => {
  const run = captureFailedCallFixture(captures.prefix_error, join(base.root, "failed-call-conflicting-context"), { retainedContext: true, rpcError: false });
  const path = join(run.execution, "02-trusted-contexts.json"), contexts = readJson(path);
  contexts[0].sessionId = "other"; writeJson(path, contexts);
  expect(() => inspectOrdinaryRecallObservation(run.root)).toThrow(/principal changed/u);
});
it("rejects multiple retained handler contexts for an unreturned call", () => {
  const run = captureFailedCallFixture(captures.prefix, join(base.root, "failed-call-duplicate-context"), { retainedContext: true, rpcError: false });
  const path = join(run.execution, "01-trusted-contexts.json"), contexts = readJson(path); writeJson(path, [...contexts, ...contexts]);
  expect(() => inspectOrdinaryRecallObservation(run.root)).toThrow(/unique trusted context/u);
});

it.each([
  { name: "nonzero exit", capture: "prefix", state: "failed", close: { code: 1, signal: null }, forced: false },
  { name: "forced termination", capture: "complete", state: "unknown", close: { code: null, signal: "SIGTERM" }, forced: true },
  { name: "signal interruption", capture: "prefix", state: "unknown", close: { code: null, signal: "SIGINT" }, forced: false }
] as const)("inspects $name with retained shutdown evidence without admitting its public prefix", ({ name, capture: mode, state, close, forced }) => {
  const capture = captures[mode], root = join(base.root, `process-${name}`); cpSync(capture.root, root, { recursive: true });
  const processResult = { status: "failed_or_interrupted", close, forced, child_error: null, process_in_flight: false, no_retry: true };
  const shutdown = { ...readJson(join(root, "execution/shutdown.json")), failure: { name: "Error", message: "fixture observation failure" } };
  writeJson(join(root, "execution/process-result.json"), processResult); writeJson(join(root, "execution/shutdown.json"), shutdown);
  const inspected = inspectOrdinaryRecallObservation(root);
  expect(inspected).toMatchObject({ state, closed: false, successfulExposures: capture.observation.calls });
  expect(inspected.evidence.calls.map(call => call.envelope)).toEqual(Array.from({ length: capture.observation.calls },
    (_, index) => readJson(join(capture.execution, `${String(index + 1).padStart(2, "0")}-public-envelope.json`))));
  expect(() => admitOrdinaryRecallObservation(root)).toThrow(/closed/u);
  expect(readJson(join(root, "execution/shutdown.json"))).toEqual(shutdown);
});
it("inspects a producer failure before daemon startup with its shutdown record", () => {
  const root = join(base.root, "daemon-start-failed"), capture = captures.prefix;
  cpSync(capture.root, root, { recursive: true });
  const execution = join(root, "execution"); rmSync(execution, { recursive: true }); mkdirSync(execution);
  writeJson(join(execution, "reservation.json"), readJson(join(capture.execution, "reservation.json")));
  writeJson(join(execution, "process-result.json"), { status: "failed_or_interrupted", close: { code: 1, signal: null },
    forced: false, child_error: null, process_in_flight: false, no_retry: true });
  writeJson(join(execution, "shutdown.json"), { ...readJson(join(capture.execution, "shutdown.json")),
    daemon_started: false, failure: { name: "Error", message: "fixture daemon startup failure" } });
  expect(inspectOrdinaryRecallObservation(root)).toMatchObject({ state: "failed", closed: false, successfulExposures: 0 });
  expect(() => admitOrdinaryRecallObservation(root)).toThrow(/closed/u);
});
it.each([{ status: "closed", close: { code: 1, signal: null } },
  { status: "failed_or_interrupted", close: { code: 0, signal: null } }])("rejects process status contradicting its exit: $status", ({ status, close }) => {
  const root = join(base.root, `contradictory-process-${status}`); cpSync(captures.prefix.root, root, { recursive: true });
  writeJson(join(root, "execution/process-result.json"), { status, close, forced: false, child_error: null, process_in_flight: false, no_retry: true });
  expect(() => inspectOrdinaryRecallObservation(root)).toThrow();
});

it.each([
  ["envelope", "execution/01-public-envelope.json", (value: unknown) => {
    const parsed = OrdinaryRecallEnvelopeSchema.parse(value); parsed.content[0]!.text += " "; return parsed;
  }],
  ["context", "execution/01-trusted-contexts.json", (value: unknown) => {
    const parsed = z.array(OrdinaryRecallContextSchema).parse(value); parsed[0]!.workspaceId = "other"; return parsed;
  }],
  ["first-exposure", "execution/01-first-exposure.json", (value: unknown) => {
    const parsed = FirstExposurePageSchema.parse(value); return { ...parsed, initial: { ...parsed.initial!, session_id: "replaced" } };
  }],
  ["producer", "preparation.json", (value: unknown) => ({ ...OrdinaryRecallPreparationSchema.parse(value), candidate: "d".repeat(40) })],
  ["request", "execution/02-request.json", (value: unknown) => {
    const parsed = OrdinaryRecallRequestRecordSchema.parse(value), continuation = parsed.arguments.payload_continuation!;
    return { ...parsed, arguments: { ...parsed.arguments, payload_continuation: { ...continuation, start_offset: (continuation.start_offset ?? 0) + 1 } } };
  }],
  ["summary", "execution/observation-final-state.json", (value: unknown) => ({ ...OrdinaryRecallObservationSchema.parse(value), source_complete: false })]
] as const)("refuses changed %s capture witnesses", (name, path, change) => {
  const root = join(base.root, `changed-${name}`); cpSync(captures.complete.root, root, { recursive: true });
  writeJson(join(root, path), change(readJson(join(root, path))));
  expect(() => admitOrdinaryRecallObservation(root)).toThrow();
});
it.each(["15.0.1", "18.2.0", "20.1.0", "21.0.0", "22.0.0", "23.0.0", "24.0.0", "25.0.0", "26.0.0", "27.0.1", "28.1.0", "29.0.1", "99.0.0"])("refuses unsupported producer version %s despite recomputed binding", protocolVersion => {
  const { root } = authoredHistoricalCapture(`unsupported-${protocolVersion}`, protocolVersion);
  expect(() => admitOrdinaryRecallObservation(root)).toThrow();
});
it("rejects a replacement preview even when its retained MCP reply agrees", () => {
  const root = join(base.root, "replaced-preview"); cpSync(captures.prefix.root, root, { recursive: true });
  rewriteCapturedEnvelope(root, 1, envelope => {
    const original = z.object({ ok: z.literal(true), output: SoulMemorySearchResponseSchema }).passthrough()
      .parse(JSON.parse(String(envelope.content[0]!.text)));
    const payload = { ...original, output: { ...original.output, results: original.output.results.map((row, index) =>
      index === 0 ? { ...row, content_preview: `!${row.content_preview.slice(1)}` } : row) } };
    envelope.content[0]!.text = JSON.stringify(payload); envelope.structuredContent = payload; return envelope;
  });
  expect(() => admitOrdinaryRecallObservation(root)).toThrow(/source|preview/u);
});
it("refuses missing first-exposure evidence", () => {
  const root = join(base.root, "removed-witness"); cpSync(captures.prefix.root, root, { recursive: true });
  unlinkSync(join(root, "execution/01-first-exposure.json"));
  expect(() => admitOrdinaryRecallObservation(root)).toThrow();
});
