import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary({ ownedTemporaryFixtures: true });
});
afterEach(() => { expect(isolation.violations).toEqual([]); });
afterAll(() => isolation.restore());
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSourceTaskObservationRequest, interpretSourceTaskObservationDecoded }
  from "../../../runs/source-task-observation/formation.js";
import { bindProviderRawAttempt, providerRawSuccessEvidenceState, readProviderRawAttempt, writeProviderRawAttempt,
  verifyProviderRawReservation } from "../../../runs/extraction/fill/provider-raw-attempt.js";
import { openExtractionAttemptLedger } from "../../../runs/extraction/authority/attempt-ledger.js";
import { settledAttemptUsageDigest } from "../../../runs/extraction/authority/attempt-ledger/outcome.js";
import type { ExtractionSuccessfulShard } from "../../../runs/extraction/authority/attempt-ledger-shards.js";
import { bindSemanticProviderRequest, semanticProviderRequestCacheKey, SOURCE_TASK_OBSERVATION_SCHEMA_NAME }
  from "../../../runs/provider-request/request-binding.js";
import { executeProviderRequestLine, type ProviderRequestLine } from "../../../runs/provider-request/execution.js";

const hash = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const clock = "2026-09-18T00:00:00.000Z", observed = "2026-09-08T00:00:00.000Z";
const query = "What drink did I try last Thursday?", body = "😀 I tried iced tea last Thursday.";
const target = (text: string) => ({ kind: "source_evidence" as const, workspace_id: "workspace",
  root_kind: "source_record" as const, root_id: "source-root", source_version: "1",
  content_digest: `sha256:${hash(text)}`, evidence_object_id: null });
const input = (text = body) => ({ query, interpretation_clock: clock,
  question_time: { interpretation_clock: clock, intervals: [{ start: "2026-09-17", end: "2026-09-17" }] },
  sources: [{ source_ref: "source1", target: target(text), source_observed_at: observed, body: text }] });
const row = { source_ref: "source1", source_excerpt: "I tried iced tea last Thursday.", query_excerpt: query,
  utterance_kind: "reported_event", description: "The speaker tried iced tea.", task_correspondence: "possible",
  task_role: "requested_event", task_component: "type of drink attempted", time_status: "interpreted",
  time_expression: "last Thursday", time_anchor: "source_observation_clock", time_start: "2026-09-03", time_end: "2026-09-03" };
const decode = (value: unknown, captured = input(), finishReason: string | null = "stop") =>
  interpretSourceTaskObservationDecoded(captured, { rawJson: JSON.stringify(value), finishReason }, "step-3.5-2603-low-json-schema-v1");

it("binds unique Unicode quotations to captured identities and clocks without asking the model for native metadata", () => {
  const request = buildSourceTaskObservationRequest(input());
  expect(request.userPrompt).not.toContain(target(body).content_digest);
  expect(request.userPrompt).not.toContain("2026-09-17");
  expect(JSON.parse(request.userPrompt)).toEqual({ question: query, question_observation_time: clock,
    sources: [{ source_ref: "source1", source_observation_time: observed, body }] });
  const result = decode({ status: "ready", observations: [row] });
  expect(result).toMatchObject({ classified: "interpreted", admitted: true,
    outcome: { status: "source_task_observation", proposal: { original_query_digest: `sha256:${hash(query)}`,
      source_task_observation: { status: "ready", observations: [{ source: target(body), source_observed_at: observed,
        source_excerpt: { start_byte: 5, end_byte: Buffer.byteLength(body), text: row.source_excerpt },
        task_correspondence: { status: "possible", role: "requested_event" },
        event_time: { status: "interpreted", interval: { start: "2026-09-03", end: "2026-09-03" } } }] } } } });
});

it("keeps unsupported, unresolved, partial, empty, unavailable and incomplete outcomes separate", () => {
  const nonpositive = (status: "unsupported" | "unresolved") => ({ ...row,
    task_correspondence: status, task_role: null, task_component: null, time_status: "unavailable",
    time_expression: null, time_anchor: null, time_start: null, time_end: null });
  for (const status of ["unsupported", "unresolved"] as const) {
    expect(decode({ status: "partial", observations: [nonpositive(status)] })).toMatchObject({ classified: "incomplete", admitted: true,
      outcome: { proposal: { source_task_observation: { status: "partial", observations: [
        { task_correspondence: { status }, event_time: { status: "unavailable" } }] } } } });
  }
  expect(decode({ status: "partial", observations: [] })).toMatchObject({ classified: "incomplete", admitted: true,
    outcome: { proposal: { source_task_observation: { status: "partial", observations: [] } } } });
  expect(decode({ status: "ready", observations: [] })).toMatchObject({ admitted: false,
    outcome: { status: "invalid", reason: "ready_omits_source" } });
  expect(decode({ status: "unavailable", observations: [] })).toMatchObject({ classified: "abstained", admitted: false,
    outcome: { status: "unavailable" } });
  expect(decode({ status: "ready", observations: [row] }, input(), "length")).toMatchObject({
    classified: "incomplete", admitted: false, outcome: { status: "incomplete" } });
});

it("rejects ambiguous or changed literals, invented refs, clocks, digests and incoherent states without repair", () => {
  expect(decode({ status: "ready", observations: [{ ...row, source_excerpt: "iced tea" }] },
    input("iced tea and iced tea"))).toMatchObject({ outcome: { status: "invalid", reason: "quote_missing_or_ambiguous" } });
  for (const changed of [{ ...row, source_excerpt: "I tried coffee last Thursday." }, { ...row, source_ref: "source2" },
    { ...row, time_expression: "next Thursday" }, { ...row, task_role: null }]) {
    expect(decode({ status: "ready", observations: [changed] }).admitted).toBe(false);
  }
  const repeated = "I tried iced tea last Thursday and mentioned last Thursday.";
  expect(decode({ status: "ready", observations: [{ ...row, source_excerpt: repeated }] }, input(repeated)))
    .toMatchObject({ admitted: false, outcome: { reason: "invalid_bound_observation" } });
  expect(decode({ status: "ready", observations: [row, row] }).outcome).toMatchObject({ reason: "duplicate_source_ref" });
  expect(() => buildSourceTaskObservationRequest({ ...input(), question_time: { ...input().question_time,
    interpretation_clock: observed } })).toThrow("question_time_clock_mismatch");
  expect(() => buildSourceTaskObservationRequest({ ...input(), sources: [{ ...input().sources[0]!, body: "changed" }] }))
    .toThrow("source_digest_mismatch");
});

it.each([{ status: "ready", classified: "interpreted" }, { status: "partial", classified: "incomplete" }] as const)(
  "executes a $status draft through the existing ledger and raw owner without provider access", async ({ status, classified }) => {
  const root = mkdtempSync(join(tmpdir(), "source-task-ledger-"));
  try {
    const model = "step-3.5-flash-2603", requestProfile = "step-3.5-2603-low-json-schema-v1" as const;
    const providerUrl = "https://api.stepfun.com/v1", config = { model, requestProfile, providerUrl, apiKey: null };
    const material = buildSourceTaskObservationRequest(input()), maxOutputTokens = 2048;
    const request = { ...material, maxOutputTokens };
    const binding = bindSemanticProviderRequest(config, request, SOURCE_TASK_OBSERVATION_SCHEMA_NAME);
    const key = semanticProviderRequestCacheKey({ identityPrefix: "source-task-observation.v1", model, requestProfile,
      systemPrompt: material.systemPrompt, userPrompt: material.userPrompt, schema: material.responseJsonSchema,
      maxOutputTokens, providerUrl, schemaName: SOURCE_TASK_OBSERVATION_SCHEMA_NAME });
    const line: ProviderRequestLine = { kind: "source_task_observation", key, requestDigest: binding.requestDigest,
      inputByteUpper: binding.inputByteUpper, ...material };
    const lineage = "b".repeat(64), usage = { inputTokens: 15, outputTokens: 12, totalTokens: 27 };
    let shard: ExtractionSuccessfulShard | undefined;
    const ledger = openExtractionAttemptLedger({ cacheRoot: root, lineageDigest: lineage,
      cacheIdentity: { model, requestProfile }, startingMissing: 1, maximumAttempts: 1, maximumAttemptsPerKey: 1,
      successfulShardCeiling: 1, inspectProviderShard: () => shard });
    const content = JSON.stringify({ status, observations: [row] });
    const wire = JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 15, completion_tokens: 12, total_tokens: 27 } });
    const httpResponse = { contentType: "application/json", bodyBase64: Buffer.from(wire).toString("base64"),
      bodyByteLength: Buffer.byteLength(wire), bodySha256: hash(wire), bodyTruncated: false, bodyComplete: true };
    const extract = vi.fn(async () => ({ rawJson: content, responseMetadata: { finishReason: "stop" }, usage, httpResponse }));
    const published: unknown[] = [];
    const run = () => executeProviderRequestLine({ cacheRoot: root, model, requestProfile, attemptLineageDigest: lineage,
      maxOutputTokens, maximumAttemptsPerKey: 1, ledger, config, suppliedExtractor: true, extractor: { extract },
      assertScope: () => undefined,
      get writeLease(): never { throw new Error("unexpected lease access"); },
      assertReservation: raw => {
        bindProviderRawAttempt(raw, { cacheKey: key, kind: "source_task_observation", model, requestProfile,
          requestDigest: binding.requestDigest, attemptLineageDigest: lineage });
        verifyProviderRawReservation(raw, ledger.snapshot(), "executable", maxOutputTokens);
      },
      interpretDecoded: (_line, decoded) => interpretSourceTaskObservationDecoded(input(), decoded, requestProfile),
      publishArtifact: value => {
        published.push(value.outcome);
        shard = { successKind: "provider", cacheKey: key, rawJsonSha256: hash(value.rawJson),
          transportProvenance: binding.transportProvenance, attemptOrdinal: value.attemptOrdinal,
          authorityLineageDigest: lineage, usageSha256: settledAttemptUsageDigest(value.usage) };
      }
    }, line);
    expect(await run()).toEqual({ classified, admitted: true, attempts: 1 });
    expect(ledger.snapshot()).toMatchObject({ attempts: 1, successfulShards: 1, successfulKeys: [key], unresolvedAttempts: [] });
    expect(readProviderRawAttempt(root, key, 1)).toMatchObject({ kind: "source_task_observation", request_digest: binding.requestDigest });
    expect(published[0]).toMatchObject({ status: "source_task_observation", proposal: { original_query_digest: `sha256:${hash(query)}` } });
    expect(await run()).toEqual({ classified, admitted: true, attempts: 1 });
    expect(extract).toHaveBeenCalledTimes(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("retains a separately identified Step physical response through the existing raw owner", () => {
  const root = mkdtempSync(join(tmpdir(), "source-task-raw-"));
  try {
    const content = JSON.stringify({ status: "partial", observations: [] });
    const wire = JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] });
    const key = "a".repeat(64), lineage = "b".repeat(64), requestDigest = "c".repeat(64);
    const binding = { cacheKey: key, kind: "source_task_observation" as const, attemptLineageDigest: lineage,
      requestDigest, model: "step-3.5-flash-2603", requestProfile: "step-3.5-2603-low-json-schema-v1" };
    const raw = writeProviderRawAttempt({ ...binding, root, attemptOrdinal: 1, decodedText: content, finishReason: "stop",
      httpResponse: { contentType: "application/json", bodyBase64: Buffer.from(wire).toString("base64"),
        bodyByteLength: Buffer.byteLength(wire), bodySha256: hash(wire), bodyTruncated: false, bodyComplete: true } });
    expect(raw.contract).toBe("source-task-observation-raw-attempt-v1");
    expect(providerRawSuccessEvidenceState(raw)).toBe("bound");
    expect(bindProviderRawAttempt(readProviderRawAttempt(root, key, 1)!, binding)).toEqual(raw);
    expect(() => bindProviderRawAttempt(raw, { ...binding, kind: "semantic_correspondence" })).toThrow(/identity mismatch/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
