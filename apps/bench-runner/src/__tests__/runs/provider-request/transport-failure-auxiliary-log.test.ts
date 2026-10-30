import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { wrapGardenHttpTransportError } from "../../../runs/compile-seed/http/garden-http-terminal-error.js";
import { openExtractionAttemptLedger } from "../../../runs/extraction/authority/attempt-ledger.js";
import { bindProviderRawAttempt, listProviderRawAttempts, providerRawAttemptPath,
  readProviderRawAttempt, verifyProviderRawReservation } from "../../../runs/extraction/fill/provider-raw-attempt.js";
import { executeProviderRequestLine, type ProviderRequestLine,
  type ProviderRequestPhysicalContext } from "../../../runs/provider-request/execution.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const FINGERPRINT = "d".repeat(64);
const USAGE = { inputTokens: 2, outputTokens: 3, totalTokens: 5 };

function transportCause(usageKnown: boolean) {
  const usage = usageKnown ? USAGE : undefined;
  return wrapGardenHttpTransportError(
    new Error("controlled loopback transport failure"),
    "failure_timeout", 0, 0, [{
      kind: "network_error", phase: "request", httpStatus: null, fingerprint: FINGERPRINT, attempt: 1,
      ...(usage === undefined ? {} : { usage })
    }]
  );
}

function openDispatch(usageKnown: boolean) {
  const cacheRoot = mkdtempSync(join(tmpdir(), "provider-request-transport-"));
  roots.push(cacheRoot);
  const model = "gemini-3.1-flash-lite";
  const requestProfile = "gemini-3.1-minimal-v1" as const;
  const line: ProviderRequestLine = { kind: "query", key: "a".repeat(64), requestDigest: "b".repeat(64),
    systemPrompt: "physical retention fixture", userPrompt: "{}", responseJsonSchema: {}, inputByteUpper: 2 };
  const attemptLineageDigest = "c".repeat(64);
  const ledger = openExtractionAttemptLedger({
    cacheRoot, lineageDigest: attemptLineageDigest, cacheIdentity: { model, requestProfile },
    startingMissing: 1, maximumAttemptsPerKey: 1
  });
  const interpretDecoded = vi.fn<ProviderRequestPhysicalContext["interpretDecoded"]>(() => {
    throw new Error("transport failure reached semantic receive");
  });
  const publishArtifact = vi.fn<ProviderRequestPhysicalContext["publishArtifact"]>();
  const extract = vi.fn(async () => { throw transportCause(usageKnown); });
  const assertScope = vi.fn();
  const dispatch = () => executeProviderRequestLine({
    cacheRoot, model, requestProfile, attemptLineageDigest, maxOutputTokens: 65536,
    maximumAttemptsPerKey: 1, ledger, interpretDecoded, publishArtifact,
    assertReservation: retained => {
      bindProviderRawAttempt(retained, { cacheKey: line.key, kind: "query", model,
        requestProfile, requestDigest: line.requestDigest, attemptLineageDigest });
      verifyProviderRawReservation(retained, ledger.snapshot(), "executable", 65536);
    },
    extractor: { extract }, suppliedExtractor: true,
    config: { model, requestProfile, providerUrl: "http://127.0.0.1:9", apiKey: null }, assertScope,
    get writeLease(): never { throw new Error("physical owner unexpectedly accessed caller lease"); }
  }, line);
  return { cacheRoot, line, ledger, extract, interpretDecoded, publishArtifact, assertScope, dispatch };
}

it.each([false, true])("settles reserved transport failure when the auxiliary diagnostic log cannot be written (usageKnown=%s)",
  async usageKnown => {
    const { cacheRoot, line, ledger, extract, interpretDecoded, publishArtifact, assertScope, dispatch } =
      openDispatch(usageKnown);
    const logPath = join(cacheRoot, "interactive-extract-errors.log");
    mkdirSync(logPath);
    expect(await dispatch()).toEqual({ classified: "retryable", admitted: false, attempts: 1 });
    expect(statSync(logPath).isDirectory()).toBe(true);
    const raws = listProviderRawAttempts(cacheRoot, line.key);
    expect(raws).toHaveLength(1);
    expect(raws[0]).toMatchObject({
      usage: usageKnown ? USAGE : null, usage_known: usageKnown,
      transport_failure: { kind: "network_error", phase: "request", fingerprint: FINGERPRINT, attempt: 1 }
    });
    expect(readProviderRawAttempt(cacheRoot, line.key, 1)).toEqual(raws[0]);
    expect(ledger.snapshot()).toMatchObject({
      attempts: 1, pendingKeys: [], unresolvedAttempts: [], successfulKeys: [],
      transportFailures: [{
        cacheKey: line.key, attemptOrdinal: 1, kind: "network_error", phase: "request",
        httpStatus: null, fingerprint: FINGERPRINT
      }],
      telemetry: {
        inputTokens: usageKnown ? 2 : 0, outputTokens: usageKnown ? 3 : 0,
        totalTokens: usageKnown ? 5 : 0, usageUnavailableRequests: usageKnown ? 0 : 1
      }
    });
    expect(publishArtifact).toHaveBeenCalledExactlyOnceWith({
      line, rawJson: "", usage: usageKnown ? USAGE : undefined,
      outcome: { status: "transport_failure", failure: raws[0]?.transport_failure },
      admitted: false, attemptOrdinal: 1, finishReason: null
    });
    expect(extract).toHaveBeenCalledTimes(1);
    expect(interpretDecoded).toHaveBeenCalledTimes(0);
    expect(assertScope).toHaveBeenCalledTimes(2);
  });

it("propagates authoritative raw persistence failure from a reserved transport failure", async () => {
  const { cacheRoot, line, ledger, extract, interpretDecoded, publishArtifact, dispatch } = openDispatch(false);
  const rawDir = join(cacheRoot, "provider-raw", line.key.slice(0, 2));
  mkdirSync(join(cacheRoot, "provider-raw"), { recursive: true });
  // Block the directory only after reservation, so replay can inspect absence.
  // A regular file obstructs mkdir on every platform, unlike POSIX chmod bits.
  extract.mockImplementation(async () => {
    writeFileSync(rawDir, "authored persistence obstruction");
    throw transportCause(false);
  });
  await expect(dispatch()).rejects.toMatchObject({ code: "EEXIST" });
  expect(statSync(rawDir).isFile()).toBe(true);
  rmSync(rawDir);
  mkdirSync(rawDir);
  expect(listProviderRawAttempts(cacheRoot, line.key)).toEqual([]);
  expect(readProviderRawAttempt(cacheRoot, line.key, 1)).toBeUndefined();
  expect(existsSync(providerRawAttemptPath(cacheRoot, line.key, 1))).toBe(false);
  expect(ledger.snapshot()).toMatchObject({
    attempts: 1, unresolvedAttempts: [{ cacheKey: line.key, attemptOrdinal: 1 }],
    settledAttempts: [], transportFailures: [], successfulKeys: []
  });
  expect(extract).toHaveBeenCalledTimes(1);
  expect(interpretDecoded).toHaveBeenCalledTimes(0);
  expect(publishArtifact).toHaveBeenCalledTimes(0);
});
