import { createHash } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, renameSync,
  rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { canonicalJson } from "@do-soul/alaya-protocol";
import { pinSemanticProposalAuthority, verifySemanticProposalAuthority } from "../../../runs/semantic-proposal/authority.js";
import { openSemanticProposalAttemptLedger } from "../../../runs/semantic-proposal/attempt.js";
import { ledgerPath, listExtractionAttemptLedgerRecords } from "../../../runs/extraction/authority/attempt-ledger.js";
import { readAttemptLedgerRecordEnvelope } from "../../../runs/extraction/authority/attempt-ledger/contract.js";
import { executeSemanticProposalFill, prepareSemanticProposal, readSemanticProposalResults } from "../../../runs/semantic-proposal/fill.js";
import { materializeSemanticProposalLines, parseSemanticProposalWorkset } from "../../../runs/semantic-proposal/workset.js";
import { listProviderRawAttempts, providerRawAttemptPath, requestEnvelopeDigest, retainedFailureOutcome, writeProviderRawAttempt } from "../../../runs/extraction/fill/provider-raw-attempt.js";
import { readSemanticChainProposalResults } from "../../../runs/semantic-chain/inputs.js";
import { syntheticGeminiBody } from "./gemini-response-evidence.test-support.js";

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

it("refuses an oversized physical ledger directory before opening a new proposal attempt", async () => {
  const { cacheRoot, authority } = fixture();
  for (let index = 0; index <= 32_768; index += 1) writeFileSync(join(cacheRoot, `unrelated-${index}`), "");
  expect(() => listExtractionAttemptLedgerRecords(cacheRoot)).toThrow(/exceeds bounded inventory/u);
  let calls = 0;
  await expect(executeSemanticProposalFill({ workset, cacheRoot, authority, config, extractor: {
    extract: async () => { calls += 1; throw new Error("inventory must reject before dispatch"); }
  } })).rejects.toThrow(/exceeds bounded inventory/u);
  expect(calls).toBe(0);
});

it("rejects cumulative ledger input and unreadable retained history without a payable miss", async () => {
  const { cacheRoot, authority } = fixture();
  const names = Array.from({ length: 4 }, (_, index) => join(cacheRoot,
    `extraction-attempt-ledger.${index.toString(16).padStart(64, "0")}.json`));
  for (const name of names) { writeFileSync(name, ""); truncateSync(name, 32 * 1024 * 1024); }
  expect(() => listExtractionAttemptLedgerRecords(cacheRoot)).toThrow(/exceeds retained input limit/u);
  for (const name of names) rmSync(name);
  writeFileSync(names[0]!, "{");
  expect(() => listExtractionAttemptLedgerRecords(cacheRoot)).toThrow(/unreadable/u);
  let calls = 0;
  await expect(executeSemanticProposalFill({ workset, cacheRoot, authority, config, extractor: {
    extract: async () => { calls += 1; throw new Error("unreadable history must reject before dispatch"); }
  } })).rejects.toThrow(/unreadable/u);
  expect(calls).toBe(0);
});

it("keeps the actual unresolved attempt in a bounded retained inventory", () => {
  const { cacheRoot, authority } = fixture();
  const ledger = openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: "query" });
  ledger.reserveAttemptOrdinal(materializeSemanticProposalLines(workset, 128)[0]!.key);
  const records = listExtractionAttemptLedgerRecords(cacheRoot);
  expect(records).toHaveLength(1);
  expect(records[0]?.attempts).toBe(1);
  expect(records[0]?.unresolved_attempts).toHaveLength(1);
  expect(openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: "query" }).snapshot()).toMatchObject({
    attempts: 1, unresolvedAttempts: [expect.any(Object)]
  });
});

it("rejects a renamed pending ledger before another proposal attempt or canonical ledger exists", async () => {
  const { cacheRoot, authority } = fixture();
  const key = materializeSemanticProposalLines(workset, 128)[0]!.key;
  openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: "query" }).reserveAttemptOrdinal(key);
  const canonical = ledgerPath(cacheRoot, authority.attempt_lineage_digest);
  const retainedBytes = readFileSync(canonical);
  const foreign = ledgerPath(cacheRoot, authority.attempt_lineage_digest === "f".repeat(64)
    ? "e".repeat(64) : "f".repeat(64));
  renameSync(canonical, foreign);
  expect(() => listExtractionAttemptLedgerRecords(cacheRoot)).toThrow(/physical filename differs from retained lineage/u);
  let calls = 0;
  await expect(executeSemanticProposalFill({ workset, cacheRoot, authority, config, extractor: {
    extract: async () => { calls += 1; throw new Error("renamed pending history must not dispatch"); }
  } })).rejects.toThrow(/physical filename differs from retained lineage/u);
  expect(calls).toBe(0);
  expect(existsSync(canonical)).toBe(false);
  expect(readFileSync(foreign)).toEqual(retainedBytes);
});

it.each(["uppercase digest", "malformed digest", "uppercase prefix", "non-JSON suffix"] as const)(
  "rejects a pending ledger named with %s before proposal dispatch", async form => {
    const { cacheRoot, authority } = fixture();
    const key = materializeSemanticProposalLines(workset, 128)[0]!.key;
    openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: "query" }).reserveAttemptOrdinal(key);
    const canonical = ledgerPath(cacheRoot, authority.attempt_lineage_digest);
    const retainedBytes = readFileSync(canonical);
    const renamed = form === "uppercase prefix"
      ? join(cacheRoot, `EXTRACTION-ATTEMPT-LEDGER.${authority.attempt_lineage_digest}.json`)
      : form === "non-JSON suffix"
        ? `${canonical}.backup`
        : join(cacheRoot, `extraction-attempt-ledger.${form === "uppercase digest"
          ? authority.attempt_lineage_digest.toUpperCase() : "malformed"}.json`);
    expect(renamed).not.toBe(canonical);
    renameSync(canonical, renamed);
    expect(() => listExtractionAttemptLedgerRecords(cacheRoot)).toThrow(/noncanonical filename/u);
    let calls = 0;
    await expect(executeSemanticProposalFill({ workset, cacheRoot, authority, config, extractor: {
      extract: async () => { calls += 1; throw new Error("noncanonical pending history must not dispatch"); }
    } })).rejects.toThrow(/noncanonical filename/u);
    expect(calls).toBe(0);
    // opendir reports the stored case; existsSync follows case-insensitive volumes.
    expect(readdirSync(cacheRoot).includes(basename(canonical))).toBe(false);
    expect(readFileSync(renamed)).toEqual(retainedBytes);
  }
);

it("rejects duplicate physical files declaring one pending ledger lineage", () => {
  const { cacheRoot, authority } = fixture();
  const key = materializeSemanticProposalLines(workset, 128)[0]!.key;
  openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: "query" }).reserveAttemptOrdinal(key);
  const canonical = ledgerPath(cacheRoot, authority.attempt_lineage_digest);
  const foreign = ledgerPath(cacheRoot, authority.attempt_lineage_digest === "f".repeat(64)
    ? "e".repeat(64) : "f".repeat(64));
  copyFileSync(canonical, foreign);
  expect(() => listExtractionAttemptLedgerRecords(cacheRoot)).toThrow(/physical filename differs from retained lineage/u);
  expect(() => openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: "query" }))
    .toThrow(/physical filename differs from retained lineage/u);
  expect(readFileSync(foreign)).toEqual(readFileSync(canonical));
});

it("rejects a duplicate malformed ledger namespace entry but ignores unrelated and publication temporary files", () => {
  const { cacheRoot, authority } = fixture();
  const key = materializeSemanticProposalLines(workset, 128)[0]!.key;
  openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: "query" }).reserveAttemptOrdinal(key);
  const canonical = ledgerPath(cacheRoot, authority.attempt_lineage_digest);
  writeFileSync(join(cacheRoot, "unrelated-retained-file.json"), "{");
  writeFileSync(join(cacheRoot, "extraction-attempt-ledger-notes.json"), "{");
  writeFileSync(join(cacheRoot, `.alaya-exclusive-publication-${"f".repeat(64)}.tmp`), "{");
  expect(listExtractionAttemptLedgerRecords(cacheRoot)).toHaveLength(1);
  expect(openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: "query" }).snapshot().unresolvedAttempts)
    .toHaveLength(1);
  const duplicate = join(cacheRoot, "extraction-attempt-ledger.malformed.json");
  copyFileSync(canonical, duplicate);
  expect(() => listExtractionAttemptLedgerRecords(cacheRoot)).toThrow(/noncanonical filename/u);
  expect(() => openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: "query" }))
    .toThrow(/noncanonical filename/u);
  expect(readFileSync(duplicate)).toEqual(readFileSync(canonical));
});

it("bounds a ledger that grows past the remaining inventory allowance before decoding it", () => {
  const { cacheRoot, authority } = fixture();
  const ledger = openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: "query" });
  ledger.reserveAttemptOrdinal(materializeSemanticProposalLines(workset, 128)[0]!.key);
  const record = listExtractionAttemptLedgerRecords(cacheRoot)[0]!;
  const path = ledgerPath(cacheRoot, record.lineage_digest);
  const allowance = statSync(path).size;
  appendFileSync(path, " ");
  expect(() => readAttemptLedgerRecordEnvelope(path, allowance)).toThrow(/size limit/u);
  expect(readAttemptLedgerRecordEnvelope(path).byteLength).toBe(allowance + 1);
});

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

it.each([
  { status: 401, attemptsPerKey: 1, retryable: false },
  { status: 403, attemptsPerKey: 1, retryable: false },
  { status: 429, attemptsPerKey: 2, retryable: true },
  { status: 503, attemptsPerKey: 2, retryable: true }
])("retains HTTP $status with only $attemptsPerKey attempt(s) per key despite remaining allowance", async ({ status, attemptsPerKey, retryable }) => {
  let calls = 0;
  const server = createServer((request, response) => {
    request.resume(); calls += 1;
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { code: status, message: "local fixture failure" } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const providerUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const prepared = { ...workset, provider_url: providerUrl }, { cacheRoot, authority } = fixture(prepared, 2);
    const run = () => executeSemanticProposalFill({ workset: prepared, cacheRoot, authority, config: { ...config, providerUrl } });
    await run();
    expect(calls).toBe(prepared.items.length * attemptsPerKey);
    for (const key of authority.keys) {
      const raws = listProviderRawAttempts(cacheRoot, key);
      expect(raws).toHaveLength(attemptsPerKey);
      for (const raw of raws) expect(raw).toMatchObject({ failure_retryable: retryable,
        transport_failure: { kind: "http_error", httpStatus: status }, usage_known: false });
    }
    const history = openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: "query" }).snapshot();
    expect(history).toMatchObject({ attempts: calls, maximumAttempts: prepared.items.length * 2,
      unresolvedAttempts: [], pendingKeys: [], successfulKeys: [] });
    expect(readSemanticProposalResults(prepared, cacheRoot, 128).map(row => row.status))
      .toEqual(prepared.items.map(() => "transport_failure"));
    await run(); expect(calls).toBe(prepared.items.length * attemptsPerKey);
    expect(openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: "query" }).snapshot()).toEqual(history);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it("settles persisted malformed raw at the single-attempt limit before dispatching the next key", async () => {
  const { cacheRoot, authority } = fixture();
  const [first] = materializeSemanticProposalLines(workset, 128);
  const ledger = openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: "query" });
  const ordinal = ledger.reserveAttemptOrdinal(first!.key);
  writeProviderRawAttempt({ root: cacheRoot, cacheKey: first!.key, attemptOrdinal: ordinal, kind: "query",
    model, requestProfile, requestDigest: first!.requestDigest, attemptLineageDigest: authority.attempt_lineage_digest, decodedText: "{", finishReason: "STOP",
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    responseBody: syntheticGeminiBody("{", "STOP", { inputTokens: 1, outputTokens: 1, totalTokens: 2 }) });
  const calls: string[] = [];
  const result = await executeSemanticProposalFill({ workset, cacheRoot, authority, config, extractor: {
    extract: async input => { calls.push(input.userPrompt); return { rawJson: "{", responseMetadata: { finishReason: "STOP" },
      responseBody: syntheticGeminiBody("{") }; }
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
            if (++originalCalls < 3) return { rawJson: "{", responseMetadata: { finishReason: "STOP" },
              responseBody: syntheticGeminiBody("{") };
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
            ...(outcome === "malformed" ? { responseBody: syntheticGeminiBody("{") } : {}),
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
    const completed = JSON.stringify({ contract: "source-semantic-query-response-v8", outcome: { status: "abstained" } });
    for (const text of ["{", completed]) {
      const ordinal = ledger.reserveAttemptOrdinal(line.key);
      writeProviderRawAttempt({ root: cacheRoot, cacheKey: line.key, attemptOrdinal: ordinal, kind: "query", model,
        requestProfile, requestDigest: line.requestDigest, attemptLineageDigest: authority.attempt_lineage_digest,
        decodedText: text, finishReason: "STOP", responseBody: syntheticGeminiBody(text) });
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
      decodedText: "{", finishReason: "STOP", responseBody: syntheticGeminiBody("{") });
    ledger.recordTransportOutcome(line.key, { retryCount: 0, rateLimitRetries: 0, successfulRequestCount: 1 }, first);
    const last = ledger.reserveAttemptOrdinal(line.key);
    writeProviderRawAttempt({ root: cacheRoot, cacheKey: line.key, attemptOrdinal: last, kind: "query", model,
      requestProfile, requestDigest: line.requestDigest, attemptLineageDigest: authority.attempt_lineage_digest,
      decodedText: outcome === "malformed" ? "{" : "", finishReason: outcome === "malformed" ? "STOP" : null,
      ...(outcome === "malformed" ? { responseBody: syntheticGeminiBody("{") } : {}),
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
