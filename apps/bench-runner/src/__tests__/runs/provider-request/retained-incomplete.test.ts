import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ledgerPath, openExtractionAttemptLedger } from "../../../runs/extraction/authority/attempt-ledger.js";
import { bindProviderRawAttempt, providerRawAttemptPath, readProviderRawAttempt,
  verifyProviderRawReservation, writeProviderRawAttempt } from "../../../runs/extraction/fill/provider-raw-attempt.js";
import { executeProviderRequestLine, replayExistingProviderRequestRaws, type ProviderRequestLine,
  type ProviderRequestPhysicalContext } from "../../../runs/provider-request/execution.js";
import { MAX_COMPLETE_PROVIDER_HTTP_RESPONSE_BYTES, readProviderResponseWithEvidence } from "../../../../../../packages/engine-gateway/src/provider/chat-completion/response-evidence.js";
import { syntheticGeminiBody } from "./gemini-response-evidence.test-support.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const RAW_CAP = 1024 * 1024;
const states = [
  { state: "bound response", truncated: false, physicalTruncated: false, step: false, reason: null },
  { state: "physical-body truncation", truncated: false, physicalTruncated: true, step: false, reason: "truncated_response_body" },
  { state: "both truncations", truncated: true, physicalTruncated: true, step: false, reason: "truncated_raw" },
  { state: "decoded-text truncation", truncated: true, physicalTruncated: false, step: true, reason: "truncated_raw" }
] as const;
const cases = (["query", "semantic_correspondence"] as const).flatMap(kind => states.flatMap(state =>
  [true, false].flatMap(usageKnown => (["live", "retained"] as const).map(path => ({ kind, ...state, usageKnown, path })))));

// Caller authorization and kernel ownership remain covered by live proposal fill tests.
// This owner unit uses real raw and ledger persistence across both physical entry paths.
it.each(cases)("settles $state for $kind through $path with usageKnown=$usageKnown",
  async ({ kind, truncated, physicalTruncated, step, reason, usageKnown, path }) => {
    const model = step ? "step-3.5-flash" : "gemini-3.1-flash-lite";
    const requestProfile = step ? "step-3.5-2603-low-json-schema-v1" as const : "gemini-3.1-minimal-v1" as const;
    const cacheRoot = mkdtempSync(join(tmpdir(), "retained-incomplete-")); roots.push(cacheRoot);
    const line: ProviderRequestLine = { kind, key: "a".repeat(64), requestDigest: "b".repeat(64),
      systemPrompt: "physical retention fixture", userPrompt: "{}", responseJsonSchema: {}, inputByteUpper: 2 };
    const attemptLineageDigest = "c".repeat(64);
    const identity = { cacheRoot, lineageDigest: attemptLineageDigest,
      cacheIdentity: { model, requestProfile }, startingMissing: 1 };
    const ledger = openExtractionAttemptLedger(identity);
    const text = reason === null ? '{"note":"café"}' : "{}" + "\n".repeat(RAW_CAP - 2 + (truncated ? 4 : 0));
    const usage = usageKnown ? { inputTokens: 2, outputTokens: 3, totalTokens: 5 } : undefined;
    const finishReason = step ? "stop" : "STOP";
    // Gemini's 64KiB physical cap cannot retain a complete >1MiB decoded response.
    // The Step evidence owner legitimately retains that fourth completeness state.
    const physical = step ? { httpResponse: (await readProviderResponseWithEvidence(new Response(JSON.stringify({
      choices: [{ message: { content: text }, finish_reason: finishReason }],
      ...(usage === undefined ? {} : { usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } })
    }), { headers: { "content-type": "application/json" } }), undefined, MAX_COMPLETE_PROVIDER_HTTP_RESPONSE_BYTES)).evidence }
      : { responseBody: syntheticGeminiBody(text, finishReason, usage) };
    const interpretDecoded = vi.fn<ProviderRequestPhysicalContext["interpretDecoded"]>(() => {
      if (reason !== null) throw new Error("incomplete physical evidence reached semantic receive");
      return { classified: "abstained", admitted: false, outcome: { status: "abstained" } };
    });
    const publishArtifact = vi.fn<ProviderRequestPhysicalContext["publishArtifact"]>();
    const reservations: number[] = [];
    const context = (current: typeof ledger): ProviderRequestPhysicalContext => ({
      cacheRoot, model, requestProfile, attemptLineageDigest, maxOutputTokens: 65536,
      maximumAttemptsPerKey: 2, ledger: current, interpretDecoded, publishArtifact,
      assertReservation: retained => {
        reservations.push(retained.attempt_ordinal);
        bindProviderRawAttempt(retained, { cacheKey: line.key, kind, model,
          requestProfile, requestDigest: line.requestDigest, attemptLineageDigest });
        verifyProviderRawReservation(retained, current.snapshot(), "executable", 65536);
      }
    });
    const extract = vi.fn(async () => ({ rawJson: text, responseMetadata: { finishReason }, ...physical,
      ...(usage === undefined ? {} : { usage }) }));
    const assertScope = vi.fn();
    const dispatch = (current: typeof ledger) => executeProviderRequestLine({ ...context(current), extractor: { extract },
      suppliedExtractor: true, config: { model, requestProfile, providerUrl: "http://127.0.0.1:9", apiKey: null }, assertScope,
      // This physical owner does not acquire or inspect the caller's lease.
      get writeLease(): never { throw new Error("physical owner unexpectedly accessed caller lease"); }
    }, line);
    const expected = { done: true, classified: reason === null ? "abstained" : "incomplete", admitted: false, attempts: 1 };
    if (path === "retained") {
      const ordinal = ledger.reserveAttemptOrdinal(line.key);
      writeProviderRawAttempt({ root: cacheRoot, cacheKey: line.key, attemptOrdinal: ordinal, kind,
        model, requestProfile, requestDigest: line.requestDigest, attemptLineageDigest,
        decodedText: text, finishReason, ...physical, ...(usage === undefined ? {} : { usage }) });
      expect(replayExistingProviderRequestRaws(context(ledger), line)).toEqual(expected);
    } else {
      expect(await dispatch(ledger)).toEqual({ classified: expected.classified, admitted: false, attempts: 1 });
    }
    const ordinal = 1;
    const rawPath = providerRawAttemptPath(cacheRoot, line.key, ordinal);
    const bytes = readFileSync(rawPath), raw = readProviderRawAttempt(cacheRoot, line.key, ordinal)!;
    expect(raw).toMatchObject({ full_replay_possible: !truncated, decoded_text_truncated: truncated,
      original_byte_length: Buffer.byteLength(text), decoded_text_digest: createHash("sha256").update(text).digest("hex"),
      finish_reason: finishReason, usage_known: usageKnown, usage: usage ?? null });
    expect(step ? raw.http_response?.bodyTruncated : raw.response_body?.truncated).toBe(physicalTruncated);
    expect(raw.decoded_text).toBe(truncated ? "{}" + "\n".repeat(RAW_CAP - 2) : text);
    expect(publishArtifact).toHaveBeenCalledExactlyOnceWith({ line, rawJson: raw.decoded_text, usage,
      outcome: reason === null ? { status: "abstained" } : { status: "invalid", reason },
      admitted: false, attemptOrdinal: ordinal, finishReason });
    expect(interpretDecoded).toHaveBeenCalledTimes(reason === null ? 1 : 0);
    expect(ledger.snapshot()).toMatchObject({ attempts: 1, pendingKeys: [], unresolvedAttempts: [],
      successfulKeys: [], successfulShards: 0,
      settledAttempts: [{ cacheKey: line.key, attemptOrdinal: ordinal, usageSha256: expect.stringMatching(/^[0-9a-f]{64}$/u) }],
      telemetry: { inputTokens: usageKnown ? 2 : 0, outputTokens: usageKnown ? 3 : 0,
        totalTokens: usageKnown ? 5 : 0, usageUnavailableRequests: usageKnown ? 0 : 1 } });
    const settledBytes = readFileSync(ledgerPath(cacheRoot, attemptLineageDigest));
    const settled = ledger.snapshot();
    for (let replay = 0; replay < 2; replay += 1) {
      const reopened = openExtractionAttemptLedger(identity);
      if (replay === 0) expect(replayExistingProviderRequestRaws(context(reopened), line)).toEqual(expected);
      else expect(await dispatch(reopened)).toEqual({ classified: expected.classified, admitted: false, attempts: 1 });
      expect(reopened.snapshot()).toEqual(settled);
      expect(readFileSync(rawPath).equals(bytes)).toBe(true);
      expect(readFileSync(ledgerPath(cacheRoot, attemptLineageDigest)).equals(settledBytes)).toBe(true);
    }
    expect(interpretDecoded).toHaveBeenCalledTimes(reason === null ? 3 : 0);
    expect(reservations).toEqual([1, 1, 1]);
    expect(extract).toHaveBeenCalledTimes(path === "live" ? 1 : 0);
    expect(assertScope).toHaveBeenCalledTimes(path === "live" ? 2 : 0);
    expect(publishArtifact.mock.calls.every(([artifact]) => artifact.admitted === false)).toBe(true);
  });
