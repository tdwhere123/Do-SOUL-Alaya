import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { inspectExtractionAuthority, readCurrentExtractionAuthorityRevision } from "../../../runs/extraction/authority/inspection.js";
import { createExtractionAuthorityReceipt, writeExtractionAuthorityReceipt } from "../../../runs/extraction/authority/receipt.js";
import { readExtractionCacheManifestIdentity } from "../../../runs/extraction/cache/extraction-cache-manifest.js";
import { readExtractionAttemptLedger } from "../../../runs/extraction/authority/attempt-ledger.js";
import type { GeminiBatchLimits } from "../../../runs/extraction/fill/batch/contract.js";
import type { BatchCampaignState } from "../../../runs/extraction/fill/batch-campaign.js";
import { runExtractionFill } from "../../../runs/extraction/extraction-fill.js";
import { buildAuthorityQuestion, buildGroundedSignalResponse, EXTRACTION_FILL_VARIANT,
  registerExtractionFillHooks, setExtractionCredentialFixture } from "./fixture.js";

let cacheRoot: string;
let dataDir: string;
let pinnedMetaRoot: string;
let server: Server | undefined;
const children = new Set<ChildProcess>();
const writeDataset = registerExtractionFillHooks((roots) => ({ cacheRoot, dataDir, pinnedMetaRoot } = roots));
afterEach(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL"); await once(child, "exit");
  }
  children.clear();
  server?.closeAllConnections();
  if (server) await new Promise<void>((done) => server!.close(() => done()));
  server = undefined;
});

async function setup(options: { unknown?: boolean; usageMissing?: boolean; maxUsd?: number;
  foreignQuote?: boolean; expensiveUsage?: boolean } = {}) {
  setExtractionCredentialFixture();
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", "gemini-2.5-flash-lite");
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", "gemini-2.5-nonthinking-v1");
  const inputFiles = new Map<string, string>();
  const jobs = new Map<string, { input: string; display: string }>();
  const provider = { creates: 0, downloads: 0, complete: true };
  let upload = 0;
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString("utf8");
    const path = new URL(req.url!, "http://fixture.invalid").pathname;
    res.setHeader("content-type", "application/json");
    if (path === "/upload/v1beta/files") {
      res.setHeader("x-goog-upload-url", `${origin}/upload/${++upload}`); res.end("{}");
    } else if (path.startsWith("/upload/")) {
      const file = `files/input${upload}`; inputFiles.set(file, body); res.end(JSON.stringify({ file: { name: file } }));
    } else if (path.endsWith(":batchGenerateContent")) {
      provider.creates += 1;
      if (options.unknown) { req.socket.destroy(); return; }
      const batch = JSON.parse(body).batch;
      const name = `batches/job${provider.creates}`;
      jobs.set(name, { input: batch.inputConfig.fileName, display: batch.displayName });
      res.end(JSON.stringify({ name }));
    } else if (path.startsWith("/v1beta/batches/")) {
      const name = path.slice("/v1beta/".length);
      const job = jobs.get(name)!;
      res.end(JSON.stringify({ name, metadata: { model: "models/gemini-2.5-flash-lite",
        inputConfig: { fileName: job.input }, displayName: job.display,
        state: provider.complete ? "BATCH_STATE_SUCCEEDED" : "BATCH_STATE_RUNNING" },
        ...(provider.complete ? { response: { responsesFile: `files/output${name.slice(-1)}` } } : {}) }));
    } else if (path.startsWith("/download/")) {
      provider.downloads += 1;
      const number = path.match(/output(\d+)/u)![1];
      const job = jobs.get(`batches/job${number}`)!;
      res.end(inputFiles.get(job.input)!.trim().split("\n").map((line) => {
        const item = JSON.parse(line);
        return JSON.stringify({ key: item.key, response: {
          candidates: [{ finishReason: "STOP", content: { parts: [{
            text: options.foreignQuote ? buildGroundedSignalResponse(JSON.stringify({
              source_assertions: [{ assertion_id: 1, text: "I completed a different task." }]
            })) : buildGroundedSignalResponse(item.request.contents[0].parts[0].text)
          }] } }], ...(options.usageMissing ? {} : {
            usageMetadata: { promptTokenCount: options.expensiveUsage ? 1_000_000 : 10,
              candidatesTokenCount: 20, totalTokenCount: options.expensiveUsage ? 1_000_020 : 30 }
          })
        } });
      }).join("\n"));
    } else { res.statusCode = 404; res.end("{}"); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", origin);
  await writeDataset([buildAuthorityQuestion("q", "alpha", "decoy")]);
  const inspection = await inspectExtractionAuthority({ variant: EXTRACTION_FILL_VARIANT, limit: 1, offset: 0,
    cacheRoot, dataDir, pinnedMetaRoot, revision: readCurrentExtractionAuthorityRevision(), action: "fill" });
  const receipt = createExtractionAuthorityReceipt({ action: "fill", observation: inspection.observation,
    outputTokenCap: { field: "maxOutputTokens", value: 512 }, diskFloorBytes: 0,
    priceEstimate: { inputUsdPerMillion: 1, outputUsdPerMillion: 2, maximumInputTokensPerAttempt: 100_000 },
    inspection: { writerLock: inspection.writerLock, disk: inspection.disk,
      credentialStatus: inspection.credentialStatus, modelReadiness: inspection.modelReadiness } });
  const authorityReceiptPath = join(cacheRoot, "authority.json");
  writeExtractionAuthorityReceipt(authorityReceiptPath, receipt);
  const limits: GeminiBatchLimits = { maxJobs: 10, maxRequestsPerJob: 1, maxFileBytes: 1_000_000,
    maxInputTokensPerJob: 1_000_000, maxEnqueuedTokens: 1_000_000, maxOutputTokens: 512,
    maxUsd: options.maxUsd ?? receipt.price.estimated_upper_usd, inputUsdPerMillion: 1, outputUsdPerMillion: 2,
    deadlineMs: 60_000, requestTimeoutMs: 2_000, maxPolls: 10 };
  const limitsPath = join(cacheRoot, "limits.json");
  writeFileSync(limitsPath, JSON.stringify(limits));
  const manifestPath = join(cacheRoot, "campaign.json");
  writeFileSync(manifestPath, JSON.stringify({ version: 1, name: "rolling", limitsPath,
    requestLimit: 1, pollIntervalMs: 1000, fill: { variant: EXTRACTION_FILL_VARIANT,
      cacheRoot, dataDir, pinnedMetaRoot, limit: 1, offset: 0, authorityReceiptPath } }));
  return { provider, manifestPath, receipt, inputFiles, limits, authorityReceiptPath };
}

function launch(manifest: string) {
  const child = spawn(process.execPath, ["--use-env-proxy", resolve("apps/bench-runner/bin/alaya-bench-runner.mjs"),
    "extraction-fill", "--batch-campaign", manifest], { cwd: process.cwd(), env: process.env });
  children.add(child);
  let output = "";
  child.stdout!.on("data", (part) => { output += String(part); });
  child.stderr!.on("data", (part) => { output += String(part); });
  const closed = once(child, "exit");
  return { child, closed, output: () => output };
}

function state(): BatchCampaignState {
  return JSON.parse(readFileSync(join(cacheRoot, ".batch-campaign", "state.json"), "utf8"));
}

it("restarts an accepted job after SIGKILL without resubmission, fills remaining windows and reuses complete cache", async () => {
  const fixture = await setup();
  fixture.provider.complete = false;
  const first = launch(fixture.manifestPath);
  await vi.waitFor(() => expect(fixture.provider.creates).toBe(1), { timeout: 20_000 });
  await vi.waitFor(() => expect(state().phase).toBe("resume"));
  first.child.kill("SIGKILL"); await first.closed;
  fixture.provider.complete = true;
  const resumed = launch(fixture.manifestPath);
  expect((await resumed.closed)[0], resumed.output()).toBe(0);
  expect(state().status).toBe("complete");
  expect(fixture.provider.creates).toBe(2);
  expect(fixture.provider.downloads).toBe(2);
  expect(readExtractionCacheManifestIdentity(cacheRoot)?.manifest.fill_status).toBe("complete");
  const ledger = readExtractionAttemptLedger({ cacheRoot, lineageDigest: fixture.receipt.lineage_digest,
    cacheIdentity: { model: fixture.receipt.observation.extraction.model,
      requestProfile: fixture.receipt.observation.extraction.requestProfile } });
  expect(ledger?.attempts).toBe(2);
  expect(ledger?.telemetry).toMatchObject({ inputTokens: 20, outputTokens: 40, totalTokens: 60 });
  const replay = launch(fixture.manifestPath);
  expect((await replay.closed)[0], replay.output()).toBe(0);
  expect(fixture.provider.creates).toBe(2);
  expect(fixture.provider.downloads).toBe(2);
}, 45_000);

it.each([{ unknown: true }, { usageMissing: true }, { foreignQuote: true }, { maxUsd: 0 }])(
  "stops durably without opening a retry window for %j", async (options) => {
    const fixture = await setup(options);
    const first = launch(fixture.manifestPath);
    expect((await first.closed)[0], first.output()).toBe(2);
    expect(state().status).toBe("stopped");
    const creates = fixture.provider.creates;
    expect(creates).toBe(options.maxUsd === 0 ? 0 : 1);
    expect(state().window).toBe(0);
    const replay = launch(fixture.manifestPath);
    expect((await replay.closed)[0], replay.output()).toBe(2);
    expect(fixture.provider.creates).toBe(creates);
  }, 30_000
);

it("keeps observed spend across windows and stops the next dispatch at the shared root budget", async () => {
  const fixture = await setup({ expensiveUsage: true, maxUsd: 0.05 });
  const run = launch(fixture.manifestPath);
  expect((await run.closed)[0], run.output()).toBe(2);
  expect(state().status).toBe("stopped");
  expect(state().window).toBe(1);
  expect(fixture.provider.creates).toBe(1);
  const ledger = readExtractionAttemptLedger({ cacheRoot, lineageDigest: fixture.receipt.lineage_digest,
    cacheIdentity: { model: fixture.receipt.observation.extraction.model,
      requestProfile: fixture.receipt.observation.extraction.requestProfile } });
  expect(ledger?.attempts).toBe(1);
  expect(ledger?.telemetry.inputTokens).toBe(1_000_000);
}, 30_000);

it.each(["quarantined", "cancelled"] as const)("does not turn a %s ordinary canary into a fresh campaign retry", async (kind) => {
  const fixture = await setup({ foreignQuote: true });
  const operations = kind === "cancelled" ? ["prepare", "cancel"] as const : ["prepare", "submit", "resume"] as const;
  for (const operation of operations) {
    await runExtractionFill({ variant: EXTRACTION_FILL_VARIANT, cacheRoot, dataDir, pinnedMetaRoot,
      offset: 0, limit: 1, authorityReceiptPath: fixture.authorityReceiptPath,
      batch: { operation, window: "canary", requestLimit: 1, limits: fixture.limits } });
  }
  const expectedCreates = kind === "cancelled" ? 0 : 1;
  expect(fixture.provider.creates).toBe(expectedCreates);
  const campaign = launch(fixture.manifestPath);
  expect((await campaign.closed)[0], campaign.output()).toBe(2);
  expect(state().status).toBe("stopped");
  expect(state().window).toBe(0);
  expect(fixture.provider.creates).toBe(expectedCreates);
}, 30_000);
