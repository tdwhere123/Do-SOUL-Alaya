import { afterAll, afterEach, expect, it, vi } from "vitest";
const boundary = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterAll(() => { expect(boundary.violations).toEqual([]); boundary.restore(); });
import { fetchLoopbackProvider } from "../../support/loopback-provider-fetch.js";
import { createServer, type RequestListener, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { executeEvidenceSelectionFill, prepareEvidenceSelection, readEvidenceSelectionResults } from "../../../runs/evidence-selection/execute.js";
import { parseEvidenceSelectionWorkset } from "../../../runs/evidence-selection/input.js";
import { pinEvidenceSelectionAuthority } from "../../../runs/evidence-selection/authority.js";
import { openEvidenceSelectionAttemptLedger } from "../../../runs/evidence-selection/attempt.js";
import { createSemanticProviderHttpExtractor } from "../../../runs/compile-seed/http/semantic-provider-http.js";
import { SOURCE_EVIDENCE_SELECTION_SCHEMA_NAME } from "../../../runs/provider-request/request-binding.js";
import { STEP_OPENAPI_QUOTE_BASIS } from "../../../runs/extraction/authority/step-quote.js";
import { readProviderRawAttempt } from "../../../runs/extraction/fill/provider-raw-attempt.js";

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const content = JSON.stringify({ status: "proposal", selected: [], unresolved: ["Authored empty preview pool."] });
function reply(res: ServerResponse) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } })}\n\ndata: [DONE]\n\n`);
}
async function fixture(handler: RequestListener, count = 1) {
  vi.stubEnv("ALAYA_ALLOW_PRIVATE_PROVIDER_URL", "true");
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing fixture port");
  const origin = `http://127.0.0.1:${address.port}`;
  const providerUrl = "https://api.stepfun.com/v1";
  const guardedFetch = globalThis.fetch;
  // Adapt only the pinned Step wire fixture; physical requests still use the original guard.
  globalThis.fetch = (url, init) => String(url) === `${providerUrl}/chat/completions`
    ? fetchLoopbackProvider(guardedFetch, new URL("/v1/chat/completions", origin), init) : guardedFetch(url, init);
  const root = mkdtempSync(join(tmpdir(), "selection-lifecycle-")); roots.push(root);
  const cacheRoot = join(root, "cache");
  const config = { model: "step-3.5-flash-2603", requestProfile: "step-3.5-2603-low-json-schema-v1" as const,
    providerUrl, apiKey: "authored-loopback-auth" };
  const workset = parseEvidenceSelectionWorkset({ contract: "source-evidence-selection-workset-v1",
    model: config.model, provider_url: providerUrl, request_profile: config.requestProfile,
    items: Array.from({ length: count }, (_, i) => ({ original_question: `authored input ${i}`, sources: [], metadata: null })) });
  const authority = pinEvidenceSelectionAuthority({ preflight: prepareEvidenceSelection(workset, cacheRoot, 128),
    inputUsdPerMillion: STEP_OPENAPI_QUOTE_BASIS.input_usd_equivalent_per_million,
    outputUsdPerMillion: STEP_OPENAPI_QUOTE_BASIS.output_usd_equivalent_per_million });
  return { server, workset, authority, cacheRoot, config,
    close: async () => { globalThis.fetch = guardedFetch; server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve())); } };
}

it("captures authorized config and workset before native readiness yields without freezing the caller", async () => {
  const bodies: string[] = [], authorization: (string | undefined)[] = [];
  const current = await fixture(async (req, res) => {
    authorization.push(req.headers.authorization);
    let body = ""; for await (const chunk of req) body += String(chunk);
    bodies.push(body); reply(res);
  });
  try {
    const original = structuredClone(current.workset);
    const pending = executeEvidenceSelectionFill(current);
    current.config.providerUrl = "http://127.0.0.1:9/mutated-route";
    current.config.apiKey = "changed-auth";
    current.workset.items[0]!.original_question = "changed question";
    current.workset.items[0]!.sources.push({ root_id: "changed-source", version: "authored", digest: `sha256:${"a".repeat(64)}`,
      span: { start: 0, end: 14 }, preview: "not authorized" });
    const result = await pending;
    expect(result).toMatchObject({ attempts: 1, interpreted: 1 });
    expect(bodies).toHaveLength(1);
    expect(authorization).toEqual(["Bearer authored-loopback-auth"]);
    expect(bodies[0]).toContain("authored input 0");
    expect(bodies[0]).not.toMatch(/changed question|not authorized/u);
    expect(readEvidenceSelectionResults(original, current.cacheRoot, 128)[0]?.status).toBe("interpreted");
    expect(current.config.providerUrl).toContain("mutated-route");
  } finally { await current.close(); }
});

it("cancels readiness at the phase deadline and refuses reservation even if readiness returns late", async () => {
  let requests = 0, cancelled = false;
  const current = await fixture((_req, res) => { requests++; reply(res); });
  const started = performance.now();
  // Keep synchronous fixture/ledger setup from consuming this readiness-only
  // deadline on a loaded runner. AbortSignal.timeout still uses the real timer.
  const clock = vi.spyOn(performance, "now").mockReturnValue(started);
  try {
    const native = createSemanticProviderHttpExtractor(current.config, SOURCE_EVIDENCE_SELECTION_SCHEMA_NAME);
    const extractor = { ...native, assertTransportReady: async (signal?: AbortSignal, timeoutMs?: number) => {
      expect(timeoutMs).toBeGreaterThan(0);
      expect(timeoutMs).toBeLessThanOrEqual(100);
      try { await delay(350, undefined, { signal }); } catch { cancelled = signal?.aborted === true; }
      // A late readiness completion must not cross into reservation, even if it swallowed cancellation.
    } };
    await expect(executeEvidenceSelectionFill({ ...current, extractor, phaseDeadlineMs: performance.now() + 100 }))
      .rejects.toThrow(/deadline|abort|timeout/iu);
    expect(cancelled).toBe(true);
    expect(requests).toBe(0);
    expect(openEvidenceSelectionAttemptLedger(current).snapshot()).toMatchObject({ attempts: 0, unresolvedAttempts: [], pendingKeys: [] });
  } finally { clock.mockRestore(); await current.close(); }
});

it("retains independent legacy readiness and request timeouts when no phase deadline is supplied", async () => {
  const current = await fixture((_req, res) => reply(res));
  try {
    const native = createSemanticProviderHttpExtractor(current.config, SOURCE_EVIDENCE_SELECTION_SCHEMA_NAME);
    const assertTransportReady = vi.fn(native.assertTransportReady!);
    const extract = vi.fn(native.extract);
    await executeEvidenceSelectionFill({ ...current, extractor: { assertTransportReady, extract } });
    expect(assertTransportReady).toHaveBeenCalledWith(undefined, 15 * 60_000);
    expect(extract.mock.calls[0]![0].timeoutMs).toBe(15 * 60_000);
    expect(extract.mock.calls[0]![0].abortSignal).toBeUndefined();
  } finally { await current.close(); }
});

it("clips the last native HTTP request to the shared phase and observably cancels its socket without later dispatch", async () => {
  let requests = 0, cancelled = false;
  let observeClose!: () => void;
  const closed = new Promise<void>(resolve => { observeClose = resolve; });
  const timers: NodeJS.Timeout[] = [];
  const current = await fixture((req, res) => {
    requests++;
    req.resume();
    if (requests !== 2) { reply(res); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.write("{");
    res.on("close", () => { cancelled = !res.writableEnded; observeClose(); });
    // Bounds the deliberately broken pre-repair case too; this is never an acceptance timeout.
    timers.push(setTimeout(() => res.end("}"), 1500));
  }, 3);
  const started = performance.now();
  try {
    const result = await executeEvidenceSelectionFill({ ...current, phaseDeadlineMs: started + 400 });
    await Promise.race([closed, delay(1800).then(() => { throw new Error("HTTP socket was not cancelled"); })]);
    expect(cancelled).toBe(true);
    expect(performance.now() - started).toBeLessThan(1200);
    expect(requests).toBe(2);
    expect(result).toMatchObject({ attempts: 2, interpreted: 1, unattempted: 1 });
    const ledger = openEvidenceSelectionAttemptLedger(current).snapshot();
    expect(ledger.attempts).toBe(2);
    expect(ledger.telemetry.usageUnavailableRequests).toBe(1);
    expect(ledger.telemetry.totalTokens).toBe(18);
    const rows = readEvidenceSelectionResults(current.workset, current.cacheRoot, 128);
    expect(rows.map(row => row.status)).toEqual(["interpreted", "transport_failure", "unattempted"]);
    expect(rows[1]!.shard?.usage).toBeUndefined();
    expect(readProviderRawAttempt(current.cacheRoot, rows[2]!.line.key, 3)).toBeUndefined();
  } finally { timers.forEach(clearTimeout); await current.close(); }
});
