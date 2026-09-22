import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { executeSemanticProposalFill, prepareSemanticProposal, readSemanticProposalResults } from "../../../runs/semantic-proposal/fill.js";
import { pinSemanticProposalAuthority } from "../../../runs/semantic-proposal/authority.js";
import { openSemanticProposalAttemptLedger } from "../../../runs/semantic-proposal/attempt.js";
import { materializeSemanticProposalLines, parseSemanticProposalWorkset } from "../../../runs/semantic-proposal/workset.js";
import { listExtractionAttemptLedgerRecords, openExtractionAttemptLedger } from "../../../runs/extraction/authority/attempt-ledger.js";
import { readProviderRawAttempt, writeProviderRawAttempt } from "../../../runs/extraction/fill/provider-raw-attempt.js";
import { semanticProposalShardPath } from "../../../runs/semantic-proposal/artifact.js";
import type { CompileSeedExtractionConfig } from "../../../runs/compile-seed/compile-seed-types.js";

const model = "gemini-3.1-flash-lite", requestProfile = "gemini-3.1-minimal-v1" as const;
const rawJson = JSON.stringify({ contract: "source-semantic-query-response-v5", outcome: { status: "abstained" } });
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function root() { const value = mkdtempSync(join(tmpdir(), "proposal-request-authority-")); roots.push(value); return value; }
function workset(provider_url = "http://127.0.0.1:9", queries = ["Who reported that Lee left?"]) {
  return parseSemanticProposalWorkset({ contract: "source-semantic-proposal-workset-v3", kind: "query",
    model, request_profile: requestProfile, provider_url, items: queries.map(original_query => ({ original_query })) });
}
function pin(prepared: ReturnType<typeof workset>, cacheRoot: string, price = 1) {
  return pinSemanticProposalAuthority({ preflight: prepareSemanticProposal(prepared, cacheRoot, 128),
    inputUsdPerMillion: price, outputUsdPerMillion: 2 });
}
function config(providerUrl = "http://127.0.0.1:9"): CompileSeedExtractionConfig {
  return { model, requestProfile, providerUrl, apiKey: "loopback-only" };
}

it("rejects alternate logical and physical routes before HTTP or reservation and binds exact cached transport", async () => {
  const wires: { url: string | undefined; body: unknown }[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      wires.push({ url: request.url, body: JSON.parse(Buffer.concat(chunks).toString()) });
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: rawJson }] } }] }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const prepared = workset(origin), cacheRoot = root(), authority = pin(prepared, cacheRoot);
    const overrides: Partial<CompileSeedExtractionConfig>[] = [
      { model: "gemini-2.5-flash-lite", requestProfile: "gemini-2.5-nonthinking-v1" },
      { requestProfile: "gemini-2.5-nonthinking-v1" }, { transportModel: "gemini-2.5-flash-lite" },
      { transportProviderUrl: "http://127.0.0.1:9" }, { providerUrl: "http://127.0.0.1:9" }
    ];
    for (const override of overrides) {
      await expect(executeSemanticProposalFill({ workset: prepared, cacheRoot, authority,
        config: { ...config(origin), ...override } })).rejects.toThrow();
      expect(wires).toEqual([]);
      expect(listExtractionAttemptLedgerRecords(cacheRoot)).toEqual([]);
    }
    const result = await executeSemanticProposalFill({ workset: prepared, cacheRoot, authority,
      config: { ...config(origin), transportProviderUrl: `${origin}/v1beta` } });
    expect(result).toMatchObject({ attempts: 1, abstained: 1 });
    expect(wires).toHaveLength(1);
    expect(wires[0]?.url).toBe("/v1beta/models/gemini-3.1-flash-lite:streamGenerateContent?alt=sse");
    expect(wires[0]?.body).toMatchObject({ generationConfig: { maxOutputTokens: 128,
      thinkingConfig: { thinkingLevel: "minimal", includeThoughts: true } } });
    const line = materializeSemanticProposalLines(prepared, 128)[0]!;
    const [retained] = readSemanticProposalResults(prepared, cacheRoot, 128);
    expect(readProviderRawAttempt(cacheRoot, line.key, 1)).toMatchObject({
      attempt_lineage_digest: authority.attempt_lineage_digest, request_digest: line.requestDigest });
    expect(retained?.shard).toMatchObject({ transport_provenance: authority.transport_provenance,
      request_digest: line.requestDigest, attempt_lineage_digest: authority.attempt_lineage_digest });
    writeFileSync(semanticProposalShardPath(cacheRoot, line.key), JSON.stringify({ ...retained!.shard,
      transport_provenance: { ...authority.transport_provenance, model: "gemini-2.5-flash-lite" } }));
    expect(() => readSemanticProposalResults(prepared, cacheRoot, 128)).toThrow(/identity mismatch/u);
    expect(prepareSemanticProposal(workset("http://127.0.0.1:9"), root(), 128).keys[0]).not.toBe(line.key);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it("preserves unknown reservations across repinned receipts and changed companion keys", async () => {
  const cacheRoot = root(), prepared = workset(undefined, ["Who reported that Lee left?", "Who left?"]);
  const authority = pin(prepared, cacheRoot), key = authority.keys[0]!;
  openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: "query" }).reserveAttemptOrdinal(key);
  const replacement = { ...prepared, items: [prepared.items[0], { original_query: "Who arrived?" }] };
  const repinned = pin(replacement, cacheRoot, 2);
  expect(repinned.identity_digest).not.toBe(authority.identity_digest);
  expect(repinned.attempt_lineage_digest).toBe(authority.attempt_lineage_digest);
  const calls: string[] = [];
  await executeSemanticProposalFill({ workset: replacement, cacheRoot, authority: repinned, config: config(), extractor: {
    extract: async input => { calls.push(input.userPrompt); return { rawJson, responseMetadata: { finishReason: "STOP" } }; }
  } });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toContain("Who arrived?");
  const snapshot = openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: "query" }).snapshot();
  expect(snapshot.attempts).toBe(2);
  expect(snapshot.unresolvedAttempts).toEqual([{ cacheKey: key, attemptOrdinal: 1 }]);
  expect(listExtractionAttemptLedgerRecords(cacheRoot)).toHaveLength(1);
  const narrowed = { ...prepared, items: [prepared.items[0]] };
  await expect(executeSemanticProposalFill({ workset: narrowed, cacheRoot,
    authority: pin(narrowed, cacheRoot, 3), config: config() })).rejects.toThrow(/ledger.*(ceiling|limit|identity)|starting/u);
});

it("does not use another reserved attempt's raw to settle an older unknown", async () => {
  const cacheRoot = root(), prepared = workset(), authority = pin(prepared, cacheRoot);
  const line = materializeSemanticProposalLines(prepared, 128)[0]!;
  const ledger = openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: "query" });
  expect(ledger.reserveAttemptOrdinal(line.key)).toBe(1);
  expect(ledger.reserveAttemptOrdinal(line.key)).toBe(2);
  writeProviderRawAttempt({ root: cacheRoot, cacheKey: line.key, attemptOrdinal: 2, kind: "query", model, requestProfile,
    requestDigest: line.requestDigest, attemptLineageDigest: authority.attempt_lineage_digest, decodedText: rawJson, finishReason: "STOP" });
  const repinned = pin(prepared, cacheRoot, 2);
  const result = await executeSemanticProposalFill({ workset: prepared, cacheRoot, authority: repinned, config: { ...config(), apiKey: null } });
  expect(result).toMatchObject({ newly_admitted: 0, abstained: 0 });
  expect(openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: "query" }).snapshot().unresolvedAttempts)
    .toEqual([{ cacheKey: line.key, attemptOrdinal: 1 }, { cacheKey: line.key, attemptOrdinal: 2 }]);
  writeProviderRawAttempt({ root: cacheRoot, cacheKey: line.key, attemptOrdinal: 1, kind: "query", model, requestProfile,
    requestDigest: line.requestDigest, attemptLineageDigest: "f".repeat(64), decodedText: rawJson, finishReason: "STOP" });
  await expect(executeSemanticProposalFill({ workset: prepared, cacheRoot, authority: repinned, config: config() }))
    .rejects.toThrow(/identity/u);
});

it("refuses to create a new lineage over a historical receipt's unknown reservation", async () => {
  const cacheRoot = root(), prepared = workset(), authority = pin(prepared, cacheRoot);
  const legacy = openExtractionAttemptLedger({ cacheRoot, lineageDigest: authority.identity_digest,
    cacheIdentity: { model, requestProfile }, startingMissing: 1, maximumAttempts: 2, successfulShardCeiling: 1 });
  legacy.reserveAttemptOrdinal(authority.keys[0]!);
  await expect(executeSemanticProposalFill({ workset: prepared, cacheRoot, authority, config: config() }))
    .rejects.toThrow(/another execution lineage/u);
  expect(listExtractionAttemptLedgerRecords(cacheRoot)).toHaveLength(1);
});

it("holds the actual fill lease across processes and preserves a killed HTTP reservation after repinning", async () => {
  const cacheRoot = root();
  let hits = 0, reached!: () => void;
  const requestReached = new Promise<void>(resolve => { reached = resolve; });
  const server = createServer((_request, _response) => { hits += 1; reached(); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const prepared = workset(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  const authority = pin(prepared, cacheRoot), repinned = pin(prepared, cacheRoot, 2);
  writeFileSync(join(cacheRoot, "workset.json"), JSON.stringify(prepared));
  writeFileSync(join(cacheRoot, "original.json"), JSON.stringify(authority));
  writeFileSync(join(cacheRoot, "repinned.json"), JSON.stringify(repinned));
  const holder = runProcess(cacheRoot, "original.json");
  try {
    await Promise.race([requestReached, holder.done.then(result => { throw new Error(`holder exited before HTTP: ${result.stderr}`); })]);
    const contender = await runProcess(cacheRoot, "repinned.json").done;
    expect(contender).toMatchObject({ code: 2, stderr: expect.stringMatching(/active writer lock/u) });
    expect(hits).toBe(1);
    holder.child.kill("SIGKILL");
    await holder.done;
    const resumed = await runProcess(cacheRoot, "repinned.json").done;
    expect(resumed).toMatchObject({ code: 0 });
    expect(JSON.parse(resumed.stdout.trim())).toMatchObject({ newly_admitted: 0, attempts: 1, terminal_failures: 1 });
    expect(hits).toBe(1);
    const snapshot = openSemanticProposalAttemptLedger({ cacheRoot, authority, kind: "query" }).snapshot();
    expect(snapshot.attempts).toBe(1);
    expect(snapshot.unresolvedAttempts).toEqual([{ cacheKey: authority.keys[0], attemptOrdinal: 1 }]);
    expect(listExtractionAttemptLedgerRecords(cacheRoot)).toHaveLength(1);
  } finally { holder.child.kill("SIGKILL"); await holder.done; server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 40_000);

function runProcess(cacheRoot: string, authorityFile: string) {
  const directory = dirname(fileURLToPath(import.meta.url));
  const child = spawn(process.execPath, [join(directory, "proposal-process-fixture.mjs")], {
    cwd: join(directory, "../../../../../.."), stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PROPOSAL_CACHE_ROOT: cacheRoot, PROPOSAL_PROCESS_MODE: "fill", PROPOSAL_AUTHORITY_PATH: join(cacheRoot, authorityFile) }
  });
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject); child.on("exit", code => resolve({ code, stdout, stderr }));
  });
  return { child, done };
}
