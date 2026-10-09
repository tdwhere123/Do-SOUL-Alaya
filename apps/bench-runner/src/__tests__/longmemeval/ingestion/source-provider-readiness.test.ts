import { lookup } from "node:dns/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { INTERN_SEMANTIC_REQUEST_MODEL as model, INTERN_SEMANTIC_PROVIDER_URL as providerUrl,
  SOURCE_SEMANTIC_TABLE_PROPOSAL_CONTRACT } from "@do-soul/alaya-protocol";
import { prepareNativeSourceRecordsSnapshot } from "../../../runs/snapshot/source-records/native.js";
import { inspectExtractionAuthority, readCurrentExtractionAuthorityRevision } from "../../../runs/extraction/authority/inspection.js";
import { preflightSourceSemanticInteractive } from "../../../runs/extraction/fill/source-semantic-interactive-preflight.js";
import { createExtractionSampleScope } from "../../../runs/extraction/authority/sample-scope.js";
import { createExtractionAuthorityReceipt, writeExtractionAuthorityReceipt } from "../../../runs/extraction/authority/receipt.js";
import { createExtractionExecutionAuthority } from "../../../runs/extraction/fill/execution-authority.js";
import { runExtractionFill } from "../../../runs/extraction/extraction-fill.js";
import { EXTRACTION_OPEN_SEMANTICS_GENERATION } from "../../../runs/extraction/request-artifact.js";
import { listProviderRawAttempts } from "../../../runs/extraction/fill/provider-raw-attempt.js";
import { inspectCachedSourceSemantic } from "../../../runs/extraction/cache/source-semantic-artifact.js";
import { prepareSourceSemanticRequestWire } from "../../../runs/extraction/fill/source-semantic-interactive-request.js";
import { setExtractionCredentialFixture } from "../extraction-fill/fixture.js";

vi.hoisted(() => { for (const key of Object.keys(process.env)) if (/API_KEY|TOKEN|SECRET/u.test(key)) delete process.env[key]; });
vi.mock("node:dns/promises", () => ({ lookup: vi.fn(async (_host: string, options?: { all?: boolean }) => {
  const answer = { address: "93.184.216.34", family: 4 }; return options?.all ? [answer] : answer;
}) }));
const roots: string[] = [], requestProfile = "intern-agents-a1-json-schema-v1" as const;
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function sourceFixture() {
  const root = mkdtempSync(join(tmpdir(), "source-provider-readiness-")); roots.push(root);
  const snapshotPath = join(root, "source.sqlite"), cacheRoot = join(root, "cache"); mkdirSync(cacheRoot);
  setExtractionCredentialFixture();
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", model);
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", requestProfile);
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", providerUrl);
  await prepareNativeSourceRecordsSnapshot({ snapshotPath, dataDirRoot: join(root, "install"),
    workspaceId: "provider-readiness", runId: "provider-readiness", producerCommit: "0".repeat(40),
    sources: [{ source_id: "source", source_version: "1", title: "Source", content_bytes: "Mira arrived.\n",
      source_observed_at: "2026-09-20T12:00:00.000Z", recorded_at: "2026-09-21T09:00:00.000Z" }] });
  const options = { variant: "native_source_snapshot" as const, nativeSourcePopulation: { name: "provider-readiness", snapshotPath },
    cacheRoot, sourcePacking: "complete-source" as const, openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION };
  const inspection = await inspectExtractionAuthority({ ...options, action: "sample", revision: readCurrentExtractionAuthorityRevision() });
  const preflight = await preflightSourceSemanticInteractive({ ...options, preflightKeys: inspection.missingKeys, preflightOutputTokenCap: 8192 });
  expect(preflight.ready_requests).toHaveLength(1);
  expect(preflight.ready_requests[0]!.key).toBe("20646fe7f59ee28ca82179e18ac4f329a36c4f3c0bfc7a64a48dd7b271594bd4");
  const receipt = createExtractionAuthorityReceipt({ action: "sample", sourcePreflight: preflight, inspection,
    observation: inspection.observation, sampleScope: createExtractionSampleScope(inspection.missingKeys, inspection), maxConcurrency: 1,
    outputTokenCap: { field: "max_tokens", value: 8192 }, diskFloorBytes: 0,
    priceEstimate: { inputUsdPerMillion: 0, outputUsdPerMillion: 0, maximumInputTokensPerAttempt: preflight.maximum_input_tokens_per_attempt } });
  const authorityReceiptPath = join(root, "authority.json"); writeExtractionAuthorityReceipt(authorityReceiptPath, receipt);
  return { options: { ...options, authorityReceiptPath, concurrency: 1 }, receipt, preflight,
    key: preflight.ready_requests[0]!.key, cacheRoot };
}

it.each(["blocked", "unresolved"])("refuses %s provider DNS before reserving a native source attempt", async failure => {
  vi.stubEnv("ALAYA_ALLOW_PRIVATE_PROVIDER_URL", "0");
  const fixture = await sourceFixture();
  if (failure === "blocked") vi.mocked(lookup).mockImplementationOnce((async () => [
    { address: "198.18.0.105", family: 4 }
  ]) as unknown as typeof lookup);
  else vi.mocked(lookup).mockRejectedValueOnce(new Error("ENOTFOUND"));
  const fetchImpl = vi.fn<typeof fetch>(); vi.stubGlobal("fetch", fetchImpl);
  await expect(runExtractionFill(fixture.options)).rejects.toThrow();
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(createExtractionExecutionAuthority(fixture.receipt, fixture.cacheRoot).snapshot())
    .toMatchObject({ attempts: 0, unresolvedAttempts: [], pendingKeys: [], settledAttempts: [], transportFailures: [] });
  expect(listProviderRawAttempts(fixture.cacheRoot, fixture.key)).toEqual([]);
  expect(inspectCachedSourceSemantic(fixture.cacheRoot, fixture.key, model, requestProfile).status).toBe("missing");
});

it("uses one allowed physical source request and replays cache without requiring current DNS readiness", async () => {
  vi.stubEnv("ALAYA_ALLOW_PRIVATE_PROVIDER_URL", "1");
  const fixture = await sourceFixture(), bodies: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    expect(request.method).toBe("POST"); expect(request.headers["content-type"]).toBe("application/json");
    bodies.push(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      contract: SOURCE_SEMANTIC_TABLE_PROPOSAL_CONTRACT, outcome: { status: "abstained" } }) }, finish_reason: "stop" }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`, nativeFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(String(input)); expect(url.href).toBe(`${providerUrl}/chat/completions`);
      expect(init?.redirect).toBe("error"); return nativeFetch(`${origin}${url.pathname}`, init);
    });
    await runExtractionFill(fixture.options);
    expect(bodies).toEqual([prepareSourceSemanticRequestWire({ model, requestProfile, providerUrl,
      apiKey: null }, fixture.preflight.ready_requests[0]!, 8192).body]);
    expect(createExtractionExecutionAuthority(fixture.receipt, fixture.cacheRoot).snapshot()?.attempts).toBe(1);
    expect(listProviderRawAttempts(fixture.cacheRoot, fixture.key)).toHaveLength(1);
    expect(inspectCachedSourceSemantic(fixture.cacheRoot, fixture.key, model, requestProfile).status).toBe("hit");
    vi.stubEnv("ALAYA_ALLOW_PRIVATE_PROVIDER_URL", "0");
    vi.mocked(lookup).mockRejectedValue(new Error("ENOTFOUND"));
    await runExtractionFill(fixture.options);
    expect(bodies).toHaveLength(1);
    expect(createExtractionExecutionAuthority(fixture.receipt, fixture.cacheRoot).snapshot()?.attempts).toBe(1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 120_000);
