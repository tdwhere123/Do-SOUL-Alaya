import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
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
import { requestEnvelopeDigest, writeProviderRawAttempt } from "../../../runs/extraction/fill/provider-raw-attempt.js";

const model = "gemini-3.1-flash-lite", requestProfile = "gemini-3.1-minimal-v1" as const;
const workset = parseSemanticProposalWorkset({ contract: "source-semantic-proposal-workset-v3", provider_url: "http://127.0.0.1:9",
  kind: "query", model, request_profile: requestProfile,
  items: [{ original_query: "Who repaired the pump?" }, { original_query: "Who inspected the pump?" }] });
const config = { providerUrl: "http://127.0.0.1:9", model, requestProfile, apiKey: "local-fixture" };
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(prepared = workset) {
  const cacheRoot = mkdtempSync(join(tmpdir(), "proposal-attempt-limit-")); roots.push(cacheRoot);
  const preflight = prepareSemanticProposal(prepared, cacheRoot, 128, 1);
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
  expect(result).toMatchObject({ attempts: 2, terminal_failures: 2 });
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
