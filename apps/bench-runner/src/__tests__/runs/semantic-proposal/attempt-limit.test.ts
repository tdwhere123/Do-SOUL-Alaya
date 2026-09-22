import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { canonicalJson } from "@do-soul/alaya-protocol";
import { pinSemanticProposalAuthority, verifySemanticProposalAuthority } from "../../../runs/semantic-proposal/authority.js";
import { openSemanticProposalAttemptLedger } from "../../../runs/semantic-proposal/attempt.js";
import { executeSemanticProposalFill, prepareSemanticProposal, readSemanticProposalResults } from "../../../runs/semantic-proposal/fill.js";
import { materializeSemanticProposalLines, parseSemanticProposalWorkset } from "../../../runs/semantic-proposal/workset.js";
import { providerRawAttemptPath, requestEnvelopeDigest, retainedFailureOutcome, writeProviderRawAttempt } from "../../../runs/extraction/fill/provider-raw-attempt.js";
import { readSemanticChainProposalResults } from "../../../runs/semantic-chain/inputs.js";

const model = "gemini-3.1-flash-lite", requestProfile = "gemini-3.1-minimal-v1" as const;
const workset = parseSemanticProposalWorkset({ contract: "source-semantic-proposal-workset-v3", provider_url: "http://127.0.0.1:9",
  kind: "query", model, request_profile: requestProfile,
  items: [{ original_query: "Who repaired the pump?" }, { original_query: "Who inspected the pump?" }] });
const config = { providerUrl: "http://127.0.0.1:9", model, requestProfile, apiKey: "local-fixture" };
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(prepared = workset, maxAttemptsPerKey = 1) {
  const cacheRoot = mkdtempSync(join(tmpdir(), "proposal-attempt-limit-")); roots.push(cacheRoot);
  const preflight = prepareSemanticProposal(prepared, cacheRoot, 128, maxAttemptsPerKey);
  const authority = pinSemanticProposalAuthority({ preflight, inputUsdPerMillion: 1, outputUsdPerMillion: 2 });
  return { cacheRoot, authority };
}

it("limits each failed HTTP request to one attempt and preserves the next key's opportunity", async () => {
  let calls = 0;
  const server = createServer((_request, response) => {
    calls += 1;
    response.writeHead(503, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { status: "UNAVAILABLE", message: "local fixture" } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as AddressInfo;
    const providerUrl = `http://127.0.0.1:${address.port}`;
    const prepared = { ...workset, provider_url: providerUrl };
    const { cacheRoot, authority } = fixture(prepared);
    const result = await executeSemanticProposalFill({ workset: prepared, cacheRoot, authority,
      config: { ...config, providerUrl } });
    expect(result).toMatchObject({ attempts: 2, terminal_failures: 2, newly_admitted: 0 });
    expect(calls).toBe(2);
    const ledger = openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: "query" }).snapshot();
    expect(ledger.maximumAttempts).toBe(2);
    expect(ledger.attempts).toBe(2);
    expect(ledger.pendingKeys).toEqual([]);
    expect(ledger.unresolvedAttempts).toEqual([]);
    expect(new Set(ledger.transportFailures.map(row => row.cacheKey)).size).toBe(2);
    const replay = await executeSemanticProposalFill({ workset: prepared, cacheRoot, authority, config: { ...config, providerUrl, apiKey: null } });
    expect(replay).toMatchObject({ cache_hits: 2, attempts: 0, newly_admitted: 0 });
    expect(calls).toBe(2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it("settles persisted malformed raw at the single-attempt limit before dispatching the next key", async () => {
  const { cacheRoot, authority } = fixture();
  const [first] = materializeSemanticProposalLines(workset, 128);
  const ledger = openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: "query" });
  const ordinal = ledger.reserveAttemptOrdinal(first!.key);
  writeProviderRawAttempt({ root: cacheRoot, cacheKey: first!.key, attemptOrdinal: ordinal, kind: "query",
    model, requestProfile, requestDigest: first!.requestDigest, attemptLineageDigest: authority.attempt_lineage_digest, decodedText: "{", finishReason: "STOP",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
  const calls: string[] = [];
  const result = await executeSemanticProposalFill({ workset, cacheRoot, authority, config, extractor: {
    extract: async input => { calls.push(input.userPrompt); return { rawJson: "{", responseMetadata: { finishReason: "STOP" } }; }
  } });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain("Who inspected the pump?");
  expect(result).toMatchObject({ attempts: 2, terminal_failures: 0, rejected: 2, unknown: 0 });
  expect(readSemanticProposalResults(workset, cacheRoot, 128).map(row => row.status)).toEqual(["invalid", "invalid"]);
  expect(openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: "query" }).snapshot()).toMatchObject({
    attempts: 2, maximumAttempts: 2, pendingKeys: [], unresolvedAttempts: []
  });
});

it("binds the per-key ceiling to both the global limit and authority identity", () => {
  const { cacheRoot, authority } = fixture();
  expect(authority.limits).toMatchObject({ maximum_attempts_per_key: 1, maximum_attempts: 2 });
  expect(prepareSemanticProposal(workset, cacheRoot, 128).maximum_attempts).toBe(4);
  for (const invalid of [0, 3]) expect(() => prepareSemanticProposal(workset, cacheRoot, 128, invalid)).toThrow();
  expect(() => verifySemanticProposalAuthority({ ...authority,
    limits: { ...authority.limits, maximum_attempts_per_key: 2 } })).toThrow(/identity digest/u);
  const { identity_digest: _digest, ...body } = authority;
  const inconsistent = { ...body, limits: { ...body.limits, maximum_attempts: 4 } };
  const identity_digest = createHash("sha256").update(canonicalJson(inconsistent)).digest("hex");
  expect(() => verifySemanticProposalAuthority({ ...inconsistent, identity_digest })).toThrow(/maximum_attempts does not bind/u);
});

it.each(["malformed", "retryable_transport"] as const)(
  "preserves the final global %s outcome through unresolved and settled raw recovery", async outcome => {
    let calls = 0;
    const server = createServer((_request, response) => {
      calls += 1;
      response.writeHead(outcome === "malformed" ? 200 : 503, { "Content-Type": "application/json" });
      response.end(JSON.stringify(outcome === "malformed"
        ? { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "{" }] } }] }
        : { error: { status: "UNAVAILABLE", message: "local fixture" } }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const providerUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      for (const mode of ["live", "unresolved", "settled"] as const) {
        const original = { ...workset, provider_url: providerUrl };
        const { cacheRoot, authority: originalAuthority } = fixture(original, 2);
        let originalCalls = 0;
        await expect(executeSemanticProposalFill({ workset: original, cacheRoot, authority: originalAuthority,
          config: { ...config, providerUrl }, extractor: { extract: async () => {
            if (++originalCalls < 3) return { rawJson: "{", responseMetadata: { finishReason: "STOP" } };
            throw Object.assign(new Error("interrupted after durable reservation"), { code: "ENOSPC" });
          } } })).rejects.toMatchObject({ code: "ENOSPC" });
        expect(originalCalls).toBe(3);
        const prepared = { ...original, items: [{ original_query: "Who cleaned the window?" }, { original_query: "Who locked the shed?" }] };
        const authority = pinSemanticProposalAuthority({ preflight: prepareSemanticProposal(prepared, cacheRoot, 128, 2),
          inputUsdPerMillion: 1, outputUsdPerMillion: 2 });
        expect(authority.attempt_lineage_digest).toBe(originalAuthority.attempt_lineage_digest);
        expect(authority.limits.maximum_attempts).toBe(4);
        const line = materializeSemanticProposalLines(prepared, 128)[0]!;
        const ledger = openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: "query" });
        if (mode !== "live") {
          const ordinal = ledger.reserveAttemptOrdinal(line.key);
          expect(ordinal).toBe(4);
          const raw = writeProviderRawAttempt({ root: cacheRoot, cacheKey: line.key, attemptOrdinal: ordinal, kind: "query",
            model, requestProfile, requestDigest: line.requestDigest, attemptLineageDigest: authority.attempt_lineage_digest,
            decodedText: outcome === "malformed" ? "{" : "", finishReason: outcome === "malformed" ? "STOP" : null,
            ...(outcome === "malformed" ? {} : { failureRetryable: true, failureClassification: "failure_max_retries",
              transportFailure: { attempt: 1, kind: "http_error", phase: "request", httpStatus: 503, fingerprint: "e".repeat(64) } }) });
          if (mode === "settled") ledger.recordTransportOutcome(line.key, retainedFailureOutcome(raw) ?? {
            retryCount: 0, rateLimitRetries: 0, successfulRequestCount: 1
          }, ordinal);
          expect(readSemanticProposalResults(prepared, cacheRoot, 128)[0]?.status).toBe("pending");
        }
        const beforeCalls = calls;
        const summary = await executeSemanticProposalFill({ workset: prepared, cacheRoot, authority,
          config: { ...config, providerUrl, apiKey: mode === "live" ? config.apiKey : null } });
        expect(calls - beforeCalls).toBe(mode === "live" ? 1 : 0);
        expect(summary).toMatchObject({ pending: 0, unknown: 0, unattempted: 1, cached_invalid: 1,
          rejected: outcome === "malformed" ? 1 : 0, terminal_failures: outcome === "malformed" ? 0 : 1 });
        const status = outcome === "malformed" ? "invalid" : "transport_failure";
        expect(readSemanticProposalResults(prepared, cacheRoot, 128).map(row => row.status)).toEqual([status, "unattempted"]);
        expect(readSemanticChainProposalResults(prepared, cacheRoot, 128).map(row => row.status)).toEqual([status, "unattempted"]);
        const snapshot = openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: "query" }).snapshot();
        expect(snapshot).toMatchObject({ attempts: 4, maximumAttempts: 4,
          unresolvedAttempts: [{ cacheKey: originalAuthority.keys[1], attemptOrdinal: 3 }] });
        expect(snapshot.pendingKeys).not.toContain(line.key);
        expect(readSemanticProposalResults(original, cacheRoot, 128)[1]?.status).toBe("unknown");
        const rawPath = providerRawAttemptPath(cacheRoot, line.key, 4), rawBytes = readFileSync(rawPath, "utf8");
        const replay = await executeSemanticProposalFill({ workset: prepared, cacheRoot, authority,
          config: { ...config, providerUrl, apiKey: null } });
        expect(replay).toMatchObject({ cache_hits: 1, pending: 0, unattempted: 1 });
        expect(readFileSync(rawPath, "utf8")).toBe(rawBytes);
        expect(calls - beforeCalls).toBe(mode === "live" ? 1 : 0);
      }
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }
);

it.each(["unresolved", "settled"] as const)(
  "replays the later reserved response before terminalizing an earlier malformed %s raw", async mode => {
    const prepared = { ...workset, items: [workset.items[0]] }, { cacheRoot, authority } = fixture(prepared, 2);
    const line = materializeSemanticProposalLines(prepared, 128)[0]!;
    const ledger = openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: "query" });
    const completed = JSON.stringify({ contract: "source-semantic-query-response-v6", outcome: { status: "abstained" } });
    for (const text of ["{", completed]) {
      const ordinal = ledger.reserveAttemptOrdinal(line.key);
      writeProviderRawAttempt({ root: cacheRoot, cacheKey: line.key, attemptOrdinal: ordinal, kind: "query", model,
        requestProfile, requestDigest: line.requestDigest, attemptLineageDigest: authority.attempt_lineage_digest,
        decodedText: text, finishReason: "STOP" });
      if (mode === "settled") ledger.recordTransportOutcome(line.key, {
        retryCount: 0, rateLimitRetries: 0, successfulRequestCount: 1
      }, ordinal);
    }
    expect(await executeSemanticProposalFill({ workset: prepared, cacheRoot, authority, config: { ...config, apiKey: null } }))
      .toMatchObject({ abstained: 1, rejected: 0, pending: 0 });
    expect(readSemanticProposalResults(prepared, cacheRoot, 128)[0]?.shard?.attempt_ordinal).toBe(2);
    expect(openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: "query" }).snapshot()).toMatchObject({
      attempts: 2, unresolvedAttempts: [], pendingKeys: []
    });
  }
);

it.each(["malformed", "retryable_transport"] as const)(
  "closes mixed settled and unresolved %s attempts at the per-key ceiling with global capacity remaining", async outcome => {
    const { cacheRoot, authority } = fixture(workset, 2);
    const line = materializeSemanticProposalLines(workset, 128)[0]!;
    const ledger = openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: "query" });
    const first = ledger.reserveAttemptOrdinal(line.key);
    writeProviderRawAttempt({ root: cacheRoot, cacheKey: line.key, attemptOrdinal: first, kind: "query", model,
      requestProfile, requestDigest: line.requestDigest, attemptLineageDigest: authority.attempt_lineage_digest,
      decodedText: "{", finishReason: "STOP" });
    ledger.recordTransportOutcome(line.key, { retryCount: 0, rateLimitRetries: 0, successfulRequestCount: 1 }, first);
    const last = ledger.reserveAttemptOrdinal(line.key);
    writeProviderRawAttempt({ root: cacheRoot, cacheKey: line.key, attemptOrdinal: last, kind: "query", model,
      requestProfile, requestDigest: line.requestDigest, attemptLineageDigest: authority.attempt_lineage_digest,
      decodedText: outcome === "malformed" ? "{" : "", finishReason: outcome === "malformed" ? "STOP" : null,
      ...(outcome === "malformed" ? {} : { failureRetryable: true, failureClassification: "failure_max_retries",
        transportFailure: { attempt: 1, kind: "http_error", phase: "request", httpStatus: 503, fingerprint: "f".repeat(64) } }) });
    expect(ledger.snapshot()).toMatchObject({ attempts: 2, maximumAttempts: 4,
      settledAttempts: [{ cacheKey: line.key, attemptOrdinal: 1 }],
      unresolvedAttempts: [{ cacheKey: line.key, attemptOrdinal: 2 }] });
    const finalRawPath = providerRawAttemptPath(cacheRoot, line.key, last), finalRaw = readFileSync(finalRawPath, "utf8");
    let calls = 0;
    const summary = await executeSemanticProposalFill({ workset: { ...workset, items: [workset.items[0]] },
      cacheRoot, authority, config: { ...config, apiKey: null }, extractor: { extract: async () => {
        calls += 1; throw new Error("exhausted key cannot dispatch");
      } } });
    expect(calls).toBe(0);
    expect(summary).toMatchObject({ attempts: 2, pending: 0, cached_invalid: 1,
      rejected: outcome === "malformed" ? 1 : 0, terminal_failures: outcome === "malformed" ? 0 : 1 });
    expect(readSemanticProposalResults(workset, cacheRoot, 128)[0]).toMatchObject({
      status: outcome === "malformed" ? "invalid" : "transport_failure", shard: { attempt_ordinal: 2 }
    });
    expect(readFileSync(finalRawPath, "utf8")).toBe(finalRaw);
    expect(openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: "query" }).snapshot()).toMatchObject({
      attempts: 2, maximumAttempts: 4, pendingKeys: [], unresolvedAttempts: []
    });
  }
);
