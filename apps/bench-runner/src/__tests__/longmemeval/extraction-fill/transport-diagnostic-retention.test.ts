import { afterAll, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterAll(() => { isolation.restore(); expect(isolation.violations).toEqual([]); });
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { inspectExtractionAuthority, readCurrentExtractionAuthorityRevision } from "../../../runs/extraction/authority/inspection.js";
import { createExtractionSampleScope } from "../../../runs/extraction/authority/sample-scope.js";
import { createExtractionAuthorityReceipt, writeExtractionAuthorityReceipt } from "../../../runs/extraction/authority/receipt.js";
import { listExtractionAttemptLedgerRecords } from "../../../runs/extraction/authority/attempt-ledger.js";
import { STEP_PLAN_QUOTE_BASIS } from "../../../runs/extraction/authority/step-quote.js";
import { preflightSourceSemanticInteractive } from "../../../runs/extraction/fill/source-semantic-interactive-preflight.js";
import { listProviderRawAttempts } from "../../../runs/extraction/fill/provider-raw-attempt.js";
import { inspectCachedSourceSemantic } from "../../../runs/extraction/cache/source-semantic-artifact.js";
import { EXTRACTION_OPEN_SEMANTICS_GENERATION } from "../../../runs/extraction/request-artifact.js";
import { buildExtractionFillQuestion, registerExtractionFillHooks, setExtractionCredentialFixture } from "./fixture.js";

const MODEL = "step-3.5-flash-2603", PROFILE = "step-3.5-2603-low-json-schema-v1";
let roots: { cacheRoot: string; dataDir: string; pinnedMetaRoot: string };
const writeDataset = registerExtractionFillHooks(value => { roots = value; }, "longmemeval_s");
const exec = promisify(execFile);

async function prepare() {
  setExtractionCredentialFixture();
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", MODEL);
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", PROFILE);
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", STEP_PLAN_QUOTE_BASIS.selected_provider_url);
  await writeDataset([buildExtractionFillQuestion("diagnostic", "I completed alpha.", "I completed beta.")]);
  const options = { ...roots, variant: "longmemeval_s" as const,
    sourcePacking: "complete-source" as const, openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION,
    concurrency: 1, log: () => undefined };
  const inspection = await inspectExtractionAuthority({ ...options,
    action: "sample", revision: readCurrentExtractionAuthorityRevision() });
  const selected = inspection.missingKeys.slice(0, 1);
  const preflight = await preflightSourceSemanticInteractive({ ...options, preflightKeys: selected });
  const receipt = createExtractionAuthorityReceipt({ action: "sample",
    sampleScope: createExtractionSampleScope(selected, inspection), observation: inspection.observation,
    inspection, maxConcurrency: 1, sourcePreflight: preflight,
    outputTokenCap: { field: "max_tokens", value: 4096 }, diskFloorBytes: 0,
    priceEstimate: { inputUsdPerMillion: STEP_PLAN_QUOTE_BASIS.input_usd_equivalent_per_million,
      outputUsdPerMillion: STEP_PLAN_QUOTE_BASIS.output_usd_equivalent_per_million,
      maximumInputTokensPerAttempt: preflight.maximum_input_tokens_per_attempt } });
  const receiptPath = join(roots.cacheRoot, "authority.json");
  writeExtractionAuthorityReceipt(receiptPath, receipt);
  return { key: selected[0]!, args: ["extraction-fill", "--variant", "s", "--data-dir", roots.dataDir,
    "--pinned-meta-root", roots.pinnedMetaRoot, "--extraction-cache-root", roots.cacheRoot,
    "--extraction-open-semantics", "--concurrency", "1", "--extraction-source-packing", "complete-source",
    "--extraction-authority", receiptPath] };
}

it.each(["refused", "reset", "append-failure", "formatter-failure"])("compiled native %s preserves one unknown-cost failure without admission", async mode => {
  const fixture = await prepare();
  let hits = 0;
  const server = createServer((request) => { hits += 1; request.socket.destroy(); });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing loopback port");
  const target = `http://127.0.0.1:${address.port}`;
  if (mode !== "reset") await new Promise<void>(done => server.close(() => done()));
  const logPath = join(roots.cacheRoot, "interactive-extract-errors.log");
  if (mode === "append-failure") mkdirSync(logPath);
  try {
    const result = await exec(process.execPath, ["--use-env-proxy", "--import",
      new URL("../../support/transport-diagnostic-bootstrap.mjs", import.meta.url).href,
      resolve("apps/bench-runner/bin/alaya-bench-runner.mjs"), ...fixture.args], {
      cwd: process.cwd(), env: { ...process.env, ALAYA_TEST_LOOPBACK_TARGET: target,
        ALAYA_TEST_DIAGNOSTIC_MODE: mode === "formatter-failure" ? mode : "transport" }, timeout: 30_000
    }).then(value => ({ ...value, code: 0 }), (error: { code: number; stdout: string; stderr: string }) => error);
    expect(result.code, result.stderr + result.stdout).toBe(2);
    expect(result.stderr).not.toContain("Provider-free test refused");
    expect(result.stderr).not.toMatch(/EISDIR|fixture formatter unavailable/u);
    const records = listExtractionAttemptLedgerRecords(roots.cacheRoot);
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record).toMatchObject({ attempts: 1, unresolved_attempts: [], pending_keys: [], successful_shards: [],
      telemetry: { usage_unavailable_requests: 1, total_tokens: 0 } });
    expect(record.settled_attempts).toHaveLength(1);
    expect(record.transport_failures).toHaveLength(1);
    const raws = listProviderRawAttempts(roots.cacheRoot, fixture.key);
    expect(raws).toHaveLength(1);
    expect(raws[0]).toMatchObject({ usage: null, usage_known: false,
      transport_failure: { kind: "network_error", phase: "request", attempt: 1 } });
    // Existing network_error/request identity has no nested-code fingerprint input.
    expect(raws[0]?.transport_failure?.fingerprint).toBe("605fb2c4c837005423955e513bc71ed01cea8449a50b0d25d23212684f030976");
    expect(record.transport_failures[0]?.fingerprint).toBe(raws[0]?.transport_failure?.fingerprint);
    expect(inspectCachedSourceSemantic(roots.cacheRoot, fixture.key, MODEL, PROFILE).status).not.toBe("hit");
    expect(hits).toBe(mode === "reset" ? 1 : 0);
    if (mode === "formatter-failure") expect(existsSync(logPath)).toBe(false);
    if (mode === "refused" || mode === "reset") {
      expect(existsSync(logPath)).toBe(true);
      const text = readFileSync(logPath, "utf8");
      expect(text).toContain("stage=unknown");
      // Node/Undici may report either socket closure or the OS reset token.
      if (mode === "reset") expect(text).toMatch(/observed_codes=(?:ECONNRESET|UND_ERR_SOCKET)\n$/u);
      else expect(text).toContain("observed_codes=ECONNREFUSED");
      expect(text).not.toContain(target);
    }
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
