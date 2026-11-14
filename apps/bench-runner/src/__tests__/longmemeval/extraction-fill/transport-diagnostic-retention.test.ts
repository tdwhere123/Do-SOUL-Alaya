import { afterAll, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../../scripts/test-support/provider-free/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterAll(() => { isolation.restore(); expect(isolation.violations).toEqual([]); });
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { inspectExtractionAuthority, readCurrentExtractionAuthorityRevision } from "../../../runs/extraction/authority/inspection.js";
import { createExtractionAuthorityReceipt, writeExtractionAuthorityReceipt } from "../../../runs/extraction/authority/receipt.js";
import { listExtractionAttemptLedgerRecords } from "../../../runs/extraction/authority/attempt-ledger.js";
import { STEP_PLAN_QUOTE_BASIS } from "../../../runs/extraction/authority/step-quote.js";
import { inspectCachedExtraction } from "../../../runs/compile-seed/cache/cache-shard.js";
import { buildExtractionFillQuestion, registerExtractionFillHooks, setExtractionCredentialFixture } from "./fixture.js";

const MODEL = "fixture-model", PROFILE = "provider-default-v1";
let roots: { cacheRoot: string; dataDir: string; pinnedMetaRoot: string };
const writeDataset = registerExtractionFillHooks(value => { roots = value; }, "longmemeval_oracle");
const exec = promisify(execFile);

async function prepare() {
  setExtractionCredentialFixture();
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", MODEL);
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", PROFILE);
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", STEP_PLAN_QUOTE_BASIS.selected_provider_url);
  await writeDataset([buildExtractionFillQuestion("diagnostic", "I completed alpha.", "I completed beta.")]);
  const inspection = await inspectExtractionAuthority({ ...roots, variant: "longmemeval_oracle",
    sourcePacking: "session-statements", action: "fill", revision: readCurrentExtractionAuthorityRevision() });
  const receipt = createExtractionAuthorityReceipt({ action: "fill", observation: inspection.observation,
    inspection, maxConcurrency: 1, outputTokenCap: { field: "max_tokens", value: 512 }, diskFloorBytes: 0,
    priceEstimate: { inputUsdPerMillion: 1, outputUsdPerMillion: 2, maximumInputTokensPerAttempt: 100_000 } });
  const receiptPath = join(roots.cacheRoot, "authority.json");
  writeExtractionAuthorityReceipt(receiptPath, receipt);
  return { keys: inspection.missingKeys, args: ["extraction-fill", "--variant", "oracle", "--data-dir", roots.dataDir,
    "--pinned-meta-root", roots.pinnedMetaRoot, "--extraction-cache-root", roots.cacheRoot,
    "--concurrency", "1", "--extraction-source-packing", "session-statements", "--extraction-authority", receiptPath] };
}

it.each(["refused", "reset"])("compiled current %s transport retains one unknown-cost attempt without admission", async mode => {
  const fixture = await prepare();
  let hits = 0;
  const server = createServer(request => { hits += 1; request.socket.destroy(); });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing loopback port");
  const target = `http://127.0.0.1:${address.port}`;
  if (mode === "refused") await new Promise<void>(done => server.close(() => done()));
  try {
    const result = await exec(process.execPath, ["--use-env-proxy", "--import",
      new URL("../../support/transport-diagnostic-bootstrap.mjs", import.meta.url).href,
      resolve("apps/bench-runner/bin/alaya-bench-runner.mjs"), ...fixture.args], {
      cwd: process.cwd(), env: { ...process.env, ALAYA_TEST_LOOPBACK_TARGET: target,
        ALAYA_TEST_DIAGNOSTIC_MODE: "transport" }, timeout: 30_000
    }).then(value => ({ ...value, code: 0 }), (error: { code: number; stdout: string; stderr: string }) => error);
    expect(result.code, result.stderr + result.stdout).toBe(1);
    expect(result.stderr).not.toContain("Provider-free test refused");
    expect(result.stderr).toContain("terminal task failure");
    expect(result.stderr).not.toContain(target);
    const records = listExtractionAttemptLedgerRecords(roots.cacheRoot);
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record).toMatchObject({ attempts: 1, unresolved_attempts: [], pending_keys: [], successful_shards: [],
      telemetry: { usage_unavailable_requests: 1, total_tokens: 0 } });
    expect(record.settled_attempts).toHaveLength(1);
    expect(record.transport_failures).toHaveLength(1);
    expect(record.transport_failures[0]).toMatchObject({ kind: "network_error", phase: "request",
      fingerprint: "605fb2c4c837005423955e513bc71ed01cea8449a50b0d25d23212684f030976" });
    for (const key of fixture.keys) expect(inspectCachedExtraction(roots.cacheRoot, key, MODEL, PROFILE).status).toBe("missing");
    expect(hits).toBe(mode === "reset" ? 1 : 0);
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise<void>(done => server.close(() => done()));
  }
}, 45_000);

it("compiled policy denial stays denied with unknown diagnostic stage and zero dispatch", async () => {
  const script = `
    import assert from 'node:assert/strict';
    const { executeProviderChatCompletion } = await import('./packages/engine-gateway/dist/index.js');
    const { formatTransportDiagnostic } = await import('./apps/bench-runner/dist/runs/extraction/fill/transport-diagnostic.js');
    let denied = false;
    try {
      await executeProviderChatCompletion({ providerUrl: 'http://127.0.0.1:1/v1',
        apiKey: 'test-key', model: 'fixture', systemPrompt: '', userPrompt: '',
        maxOutputTokens: 1, timeoutMs: 1000, env: {} }, { maxRetries: 0, retryDelaysMs: [] });
    } catch (cause) {
      denied = true;
      assert.equal(cause.kind, 'network_error');
      assert.match(cause.cause.message, /private, loopback, link-local, or metadata/);
      assert.equal(formatTransportDiagnostic(cause), 'transport_observation stage=unknown observed_codes=unknown');
    }
    assert.equal(denied, true);
  `;
  const result = await exec(process.execPath, ["--use-env-proxy", "--import",
    new URL("../../support/transport-diagnostic-bootstrap.mjs", import.meta.url).href,
    "--input-type=module", "--eval", script], { cwd: process.cwd(), env: { ...process.env,
      ALAYA_TEST_DIAGNOSTIC_MODE: "policy", ALAYA_TEST_LOOPBACK_TARGET: "http://127.0.0.1:1" }, timeout: 30_000 });
  expect(result.stderr).toBe("");
});
