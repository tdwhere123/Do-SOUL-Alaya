import { afterAll, beforeAll, expect, it, vi } from "vitest";

const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});

import { cpSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { sourceDisclosure, SourceDisclosureSchema, SoulMemorySearchResponseSchema } from "@do-soul/alaya-protocol";
import { chainIdentity } from "../../../runs/recall-measurement/contract.js";
import { admitOrdinaryRecallObservation, inspectOrdinaryRecallObservation } from "../../../runs/recall-measurement/ordinary/ordinary-recall.js";
import { OrdinaryRecallContextSchema, OrdinaryRecallEnvelopeSchema, OrdinaryRecallObservationSchema,
  OrdinaryRecallPreparationSchema, OrdinaryRecallRequestRecordSchema,
  OrdinaryRecallWireRecordSchema } from "../../../runs/recall-measurement/ordinary/ordinary-recall-contract.js";
import { FirstExposurePageSchema } from "../../../runs/measurement/first-exposure-session.js";
import { nativeRecallFixture, HIDDEN_GOLD, HIDDEN_SOURCE } from "./native-recall.test-support.js";
import { captureFailedCallFixture, captureOrdinaryFixture, readJson, writeJson } from "./ordinary-capture.test-support.js";

let base: Awaited<ReturnType<typeof nativeRecallFixture>>;
const captures = {} as Record<"complete" | "prefix" | "prefix_error" | "error", Awaited<ReturnType<typeof captureOrdinaryFixture>>>;
beforeAll(async () => {
  base = await nativeRecallFixture(`Project Aster was mentioned. ${"Other project context. ".repeat(160)}${HIDDEN_SOURCE}`);
  for (const mode of ["complete", "prefix", "prefix_error", "error"] as const) captures[mode] = await captureOrdinaryFixture(base, mode);
}, 120000);
afterAll(() => {
  vi.restoreAllMocks();
  if (base !== undefined) rmSync(base.root, { recursive: true, force: true });
  isolation.restore(); expect(isolation.violations).toEqual([]);
});

function captureWithProtocolVersion(name: string, protocolVersion: string) {
  const root = join(base.root, name); cpSync(captures.prefix.root, root, { recursive: true });
  const config = readJson(join(root, "config.json")); config.protocol_package_version = protocolVersion;
  writeJson(join(root, "config.json"), config);
  for (const path of ["preparation.json", "execution/reservation.json"]) {
    const value = readJson(join(root, path)); value.config_identity = chainIdentity(config); writeJson(join(root, path), value);
  }
  if (protocolVersion !== "19.0.0") {
    // Historical producers emitted named objects; pre-18 records predate representation metadata.
    rewriteCapturedEnvelope(root, 1, envelope => {
      const block = envelope.content.find(value => value.type === "text")!;
      const payload = JSON.parse(String(block.text));
      for (const row of payload.output.results) {
        row.source_disclosure = sourceDisclosure(SourceDisclosureSchema.parse(row.source_disclosure));
        if (["14.1.0", "15.0.0", "16.0.0", "17.0.0"].includes(protocolVersion)) row.source_disclosure.material_kind = "original_body";
      }
      return { ...envelope, structuredContent: payload,
        content: envelope.content.map(value => value === block ? { ...block, text: JSON.stringify(payload) } : value) };
    });
  }
  return { root, config };
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
  expect(observation.evidence.calls.map(call => call.envelope)).toEqual(Array.from({ length: capture.observation.calls },
    (_, index) => readJson(join(capture.execution, `${String(index + 1).padStart(2, "0")}-public-envelope.json`))));
  expect(JSON.stringify(observation.evidence)).not.toContain(HIDDEN_GOLD);
  expect(JSON.stringify(observation.evidence).includes(HIDDEN_SOURCE)).toBe(mode === "complete");
  if (mode === "prefix_error") expect(observation.evidence.calls.at(-1)).toMatchObject({ response_state: "public_error" });
});

it.each(["14.1.0", "15.0.0", "16.0.0", "17.0.0", "18.0.0", "18.1.0"])("admits a %s archive without rewriting producer provenance", protocolVersion => {
  const { root, config } = captureWithProtocolVersion(`historical-${protocolVersion}`, protocolVersion);
  const original = readFileSync(join(root, "config.json"), "utf8");
  const originalEnvelope = readFileSync(join(root, "execution/01-public-envelope.json"), "utf8");
  const observation = admitOrdinaryRecallObservation(root);
  expect(observation.binding).toMatchObject({ protocol_package_version: protocolVersion, reader_protocol_package_version: "19.0.0",
    producer_candidate: config.candidate, producer_revision: config.implementation_revision });
  expect(observation.state).toBe("partial");
  expect(readFileSync(join(root, "config.json"), "utf8")).toBe(original);
  expect(readFileSync(join(root, "execution/01-public-envelope.json"), "utf8")).toBe(originalEnvelope);
});

it.each(["18.0.0", "18.1.0", "19.0.0"])("refuses legacy original-body qualification relabeled as a %s capture", protocolVersion => {
  const { root, config } = captureWithProtocolVersion(`original-overclaim-${protocolVersion}`, "17.0.0");
  config.protocol_package_version = protocolVersion; writeJson(join(root, "config.json"), config);
  for (const path of ["preparation.json", "execution/reservation.json"]) {
    const value = readJson(join(root, path)); value.config_identity = chainIdentity(config); writeJson(join(root, path), value);
  }
  if (protocolVersion !== "19.0.0") {
    expect(() => admitOrdinaryRecallObservation(root)).toThrow("public source qualifications differ from sealed metadata");
  } else expect(() => admitOrdinaryRecallObservation(root)).toThrow(z.ZodError);
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
it.each(["15.0.1", "18.2.0", "20.0.0"])("refuses unsupported producer version %s despite recomputed binding", protocolVersion => {
  const { root } = captureWithProtocolVersion(`unsupported-${protocolVersion}`, protocolVersion);
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
