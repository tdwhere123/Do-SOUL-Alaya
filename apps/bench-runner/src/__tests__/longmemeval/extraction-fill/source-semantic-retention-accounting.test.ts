import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { runCli } from "../../../cli/cli.js";
import { inspectExtractionAuthority, readCurrentExtractionAuthorityRevision } from "../../../runs/extraction/authority/inspection.js";
import { createExtractionAuthorityReceipt, writeExtractionAuthorityReceipt } from "../../../runs/extraction/authority/receipt.js";
import { listExtractionAttemptLedgerRecords } from "../../../runs/extraction/authority/attempt-ledger.js";
import * as sourceArtifacts from "../../../runs/extraction/cache/source-semantic-artifact.js";
import * as rawAttempts from "../../../runs/extraction/fill/provider-raw-attempt.js";
import { cacheFilePath } from "../../../runs/compile-seed/cache/cache-shard.js";
import { EXTRACTION_OPEN_SEMANTICS_GENERATION } from "../../../runs/extraction/request-artifact.js";
import { buildExtractionFillQuestion, registerExtractionFillHooks, setExtractionCredentialFixture } from "./fixture.js";

const MODEL = "gemini-2.5-flash-lite";
const REQUEST_PROFILE = "gemini-2.5-nonthinking-v1" as const;
const ABSTAINED = JSON.stringify({ contract: "source-semantic-proposal-v6", outcome: { status: "abstained" } });
const OVERSIZED = ABSTAINED + "\n".repeat(1024 * 1024);
const FULL_DIGEST = createHash("sha256").update(OVERSIZED).digest("hex");
const execFileAsync = promisify(execFile);
let cacheRoot: string, dataDir: string, pinnedMetaRoot: string;
const writeDataset = registerExtractionFillHooks(roots => ({ cacheRoot, dataDir, pinnedMetaRoot } = roots), "longmemeval_s");
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function setup(usageKnown: boolean, responseText = OVERSIZED) {
  setExtractionCredentialFixture();
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", MODEL);
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", REQUEST_PROFILE);
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", "https://fixture-provider.invalid");
  await writeDataset([buildExtractionFillQuestion("retained", "I signed the amber ledger.", "I sealed the blue parcel.")]);
  const inspection = await inspectExtractionAuthority({
    variant: "longmemeval_s", cacheRoot, dataDir, pinnedMetaRoot, sourcePacking: "complete-source",
    openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION, revision: readCurrentExtractionAuthorityRevision(), action: "fill"
  });
  const receipt = createExtractionAuthorityReceipt({
    action: "fill", observation: inspection.observation,
    outputTokenCap: { field: "maxOutputTokens", value: 4096 }, diskFloorBytes: 0,
    priceEstimate: { inputUsdPerMillion: 1, outputUsdPerMillion: 2, maximumInputTokensPerAttempt: 100000 }, inspection
  });
  const receiptPath = join(cacheRoot, "authority.json");
  writeExtractionAuthorityReceipt(receiptPath, receipt);
  const fetchMock = vi.fn<typeof fetch>(async url => {
    expect(new URL(String(url)).pathname).toMatch(/:streamGenerateContent$/u);
    return Response.json({
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: responseText }] } }],
      ...(usageKnown ? { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 } } : {})
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  const keys = inspection.missingKeys;
  expect(keys).toHaveLength(2);
  return { keys, fetchMock, args: [
    "extraction-fill", "--variant", "s", "--data-dir", dataDir, "--pinned-meta-root", pinnedMetaRoot,
    "--extraction-cache-root", cacheRoot, "--extraction-open-semantics", "--concurrency", String(keys.length),
    "--extraction-source-packing", "complete-source", "--extraction-authority", receiptPath
  ] };
}

function ledger() {
  const records = listExtractionAttemptLedgerRecords(cacheRoot);
  expect(records).toHaveLength(1);
  return records[0]!;
}

async function restartCli(args: string[]) {
  await execFileAsync(process.execPath, ["--use-env-proxy", resolve("apps/bench-runner/bin/alaya-bench-runner.mjs"), ...args],
    { cwd: process.cwd(), env: process.env, timeout: 30_000 });
}

function expectSettledQuarantine(keys: readonly string[], usageKnown: boolean, fingerprint: string) {
  const record = ledger();
  expect(record.attempts).toBe(keys.length);
  expect(record.unresolved_attempts).toEqual([]);
  expect(record.pending_keys).toEqual([]);
  expect(record.settled_attempts).toHaveLength(keys.length);
  expect(record.successful_shards).toEqual([]);
  expect(record.transport_failures).toHaveLength(keys.length);
  for (const key of keys) {
    const raw = rawAttempts.listProviderRawAttempts(cacheRoot, key)[0]!;
    expect(record.settled_attempts).toContainEqual({ cache_key: key, attempt_ordinal: raw.attempt_ordinal });
    expect(record.transport_failures).toContainEqual({
      cache_key: key, attempt_ordinal: raw.attempt_ordinal,
      kind: "response_schema_error", phase: "response_schema", http_status: null, fingerprint
    });
    expect(sourceArtifacts.inspectCachedSourceSemantic(cacheRoot, key, MODEL, REQUEST_PROFILE).status).not.toBe("hit");
    expect(existsSync(cacheFilePath(cacheRoot, key))).toBe(false);
  }
  expect(record.telemetry).toMatchObject({
    input_tokens: usageKnown ? 10 * keys.length : 0,
    output_tokens: usageKnown ? 20 * keys.length : 0,
    total_tokens: usageKnown ? 30 * keys.length : 0,
    usage_unavailable_requests: usageKnown ? 0 : keys.length,
    terminal: { failure_non_retryable_response: keys.length }
  });
  return record;
}

it.each([
  { path: "live", usageKnown: true }, { path: "live", usageKnown: false },
  { path: "retained recovery", usageKnown: true }, { path: "retained recovery", usageKnown: false }
])("settles completed oversized source response once through $path with usageKnown=$usageKnown", async ({ path, usageKnown }) => {
  const fixture = await setup(usageKnown);
  if (path === "retained recovery") {
    const writeRaw = rawAttempts.writeProviderRawAttempt;
    const interrupt = vi.spyOn(rawAttempts, "writeProviderRawAttempt").mockImplementation(input => {
      writeRaw(input);
      throw new Error("fixture interruption after durable raw publication");
    });
    expect(await runCli(fixture.args)).toBe(2);
    interrupt.mockRestore();
    const interrupted = ledger();
    expect(interrupted.unresolved_attempts).toHaveLength(fixture.keys.length);
    expect(interrupted.pending_keys).toHaveLength(fixture.keys.length);
    expect(interrupted.telemetry).toMatchObject({ total_tokens: 0, usage_unavailable_requests: 0 });
  }
  if (path === "retained recovery") await restartCli(fixture.args);
  else expect(await runCli(fixture.args)).toBe(0);
  expect(fixture.fetchMock).toHaveBeenCalledTimes(fixture.keys.length);
  const raws = fixture.keys.flatMap(key => rawAttempts.listProviderRawAttempts(cacheRoot, key));
  expect(raws).toHaveLength(fixture.keys.length);
  for (const raw of raws) {
    expect(raw).toMatchObject({
      full_replay_possible: false, decoded_text_truncated: true, decoded_text_digest: FULL_DIGEST,
      original_byte_length: Buffer.byteLength(OVERSIZED), finish_reason: "STOP", completion_witness: "finish_reason",
      usage_known: usageKnown, usage: usageKnown ? { inputTokens: 10, outputTokens: 20, totalTokens: 30 } : null
    });
    // Even a syntactically complete retained prefix must never be admitted as the full response.
    expect(JSON.parse(raw.decoded_text)).toEqual(JSON.parse(ABSTAINED));
    expect(createHash("sha256").update(raw.decoded_text).digest("hex")).not.toBe(FULL_DIGEST);
  }
  const settled = expectSettledQuarantine(fixture.keys, usageKnown, FULL_DIGEST);
  const rawBytes = raws.map(raw => readFileSync(rawAttempts.providerRawAttemptPath(cacheRoot, raw.cache_key, raw.attempt_ordinal), "utf8"));
  for (let replay = 0; replay < 2; replay += 1) {
    expect(await runCli(fixture.args)).toBe(0);
    expect(ledger()).toEqual(settled);
    expect(raws.map(raw => readFileSync(rawAttempts.providerRawAttemptPath(cacheRoot, raw.cache_key, raw.attempt_ordinal), "utf8"))).toEqual(rawBytes);
    expect(fixture.fetchMock).toHaveBeenCalledTimes(fixture.keys.length);
    expectSettledQuarantine(fixture.keys, usageKnown, FULL_DIGEST);
  }
}, 60000);

it.each([true, false])("recovers a complete escaped source response with usageKnown=%s exactly once", async usageKnown => {
  const response = ABSTAINED + "\n".repeat(1024 * 1024 - Buffer.byteLength(ABSTAINED));
  const fixture = await setup(usageKnown, response);
  const writeRaw = rawAttempts.writeProviderRawAttempt;
  const interrupt = vi.spyOn(rawAttempts, "writeProviderRawAttempt").mockImplementation(input => {
    writeRaw(input);
    throw new Error("fixture interruption after durable raw publication");
  });
  expect(await runCli(fixture.args)).toBe(2);
  interrupt.mockRestore();
  expect(ledger().unresolved_attempts).toHaveLength(fixture.keys.length);
  for (const key of fixture.keys) {
    expect(rawAttempts.listProviderRawAttempts(cacheRoot, key)[0]).toMatchObject({ decoded_text: response,
      decoded_text_truncated: false, full_replay_possible: true, original_byte_length: 1024 * 1024,
      decoded_text_digest: createHash("sha256").update(response).digest("hex"), usage_known: usageKnown });
  }
  await restartCli(fixture.args);
  const settled = ledger();
  expect(settled).toMatchObject({ attempts: fixture.keys.length, unresolved_attempts: [], pending_keys: [],
    transport_failures: [], telemetry: { input_tokens: usageKnown ? 20 : 0, output_tokens: usageKnown ? 40 : 0,
      total_tokens: usageKnown ? 60 : 0, usage_unavailable_requests: usageKnown ? 0 : fixture.keys.length } });
  expect(settled.successful_shards).toHaveLength(fixture.keys.length);
  expect(settled.settled_attempts).toHaveLength(fixture.keys.length);
  for (let replay = 0; replay < 2; replay += 1) {
    expect(await runCli(fixture.args)).toBe(0);
    expect(ledger()).toEqual(settled);
    for (const key of fixture.keys) {
      expect(sourceArtifacts.inspectCachedSourceSemantic(cacheRoot, key, MODEL, REQUEST_PROFILE).status).toBe("hit");
    }
    expect(fixture.fetchMock).toHaveBeenCalledTimes(fixture.keys.length);
  }
}, 60000);

it("settles completed usage once and recovers intact raw after a published source shard disappears", async () => {
  const fixture = await setup(true, ABSTAINED);
  const importArtifact = sourceArtifacts.importSourceSemanticArtifact;
  const removePublished = vi.spyOn(sourceArtifacts, "importSourceSemanticArtifact").mockImplementation(input => {
    const result = importArtifact(input);
    const path = cacheFilePath(input.cacheRoot, input.result.line.key);
    expect(existsSync(path)).toBe(true);
    unlinkSync(path);
    return result;
  });
  expect(await runCli(fixture.args)).toBe(0);
  const settled = ledger();
  expect(settled).toMatchObject({
    attempts: 2, unresolved_attempts: [], pending_keys: [...fixture.keys].sort(),
    successful_shards: [], transport_failures: [],
    telemetry: {
      input_tokens: 20, output_tokens: 40, total_tokens: 60, usage_unavailable_requests: 0,
      terminal: { failure_non_retryable_response: 0 }
    }
  });
  expect(settled.settled_attempts).toHaveLength(2);
  for (const key of fixture.keys) {
    expect(existsSync(cacheFilePath(cacheRoot, key))).toBe(false);
    expect(rawAttempts.listProviderRawAttempts(cacheRoot, key)[0]).toMatchObject({
      decoded_text: ABSTAINED, full_replay_possible: true, finish_reason: "STOP", usage_known: true
    });
  }
  for (let replay = 0; replay < 2; replay += 1) {
    expect(await runCli(fixture.args)).toBe(0);
    expect(ledger()).toEqual(settled);
    expect(fixture.fetchMock).toHaveBeenCalledTimes(fixture.keys.length);
    for (const key of fixture.keys) expect(existsSync(cacheFilePath(cacheRoot, key))).toBe(false);
  }
  removePublished.mockRestore();
  vi.stubEnv("E0_TEST_GARDEN_KEY", "");
  expect(await runCli(fixture.args)).toBe(2);
  expect(ledger()).toEqual(settled);
  expect(fixture.fetchMock).toHaveBeenCalledTimes(fixture.keys.length);
  setExtractionCredentialFixture();
  for (let replay = 0; replay < 2; replay += 1) {
    expect(await runCli(fixture.args)).toBe(0);
    const recovered = ledger();
    expect(recovered.attempts).toBe(2);
    expect(recovered.unresolved_attempts).toEqual([]);
    expect(recovered.pending_keys).toEqual([]);
    expect(recovered.settled_attempts).toEqual(settled.settled_attempts);
    expect(recovered.transport_failures).toEqual([]);
    expect(recovered.successful_shards).toHaveLength(2);
    expect(recovered.telemetry).toEqual(settled.telemetry);
    for (const key of fixture.keys) {
      expect(sourceArtifacts.inspectCachedSourceSemantic(cacheRoot, key, MODEL, REQUEST_PROFILE).status).toBe("hit");
    }
    expect(fixture.fetchMock).toHaveBeenCalledTimes(fixture.keys.length);
  }
}, 60000);
