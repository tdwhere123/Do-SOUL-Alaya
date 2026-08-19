import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import { writeLongMemEvalFixtureDataset, buildLongMemEvalFixtureQuestion } from
  "../../longmemeval/longmemeval-fixture.js";
import { prepareExtractionFillWindow } from
  "../../../bench/extraction/fill/fill-window.js";
import { requiredExtractionCacheKeys } from
  "../../../bench/compile-seed/preflight/cache-window-key-binding.js";
import { writeCachedExtraction } from
  "../../../bench/compile-seed/cache/cache-shard.js";
import {
  computeExtractionContentClosureSha256,
  computeExtractionKeySetSha256,
  inspectExtractionRawJson
} from "../../../bench/extraction/content-closure.js";
import {
  computeSystemPromptSha256,
  readExtractionCacheManifestIdentity,
  writeExtractionCacheManifest
} from "../../../bench/extraction/cache/extraction-cache-manifest.js";
import { manifestFor } from
  "../../longmemeval/extraction/extraction-cache-preflight-fixture.js";
import { execFileAsync } from "./fixture.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const helper = path.resolve(here, "../../../../scripts/prove-cache-only-replay.mjs");
const bin = path.resolve(here, "../../../../bin/alaya-bench-runner.mjs");
const MODEL = "mimo-v2.5";
const PROFILE = "mimo-v2.5-nonthinking-v1";
const PROVIDER = "https://fixture-provider.invalid/v1";

describe("canonical cache-only replay process", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "canonical-replay-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("derives the full selected-window request and reaches real zero-call preflight", async () => {
    const prepared = await prepareCanonicalProcessFixture(root);
    expectManifestMatchesFixture(prepared.manifest, prepared.fixture);
    const result = await runReplayConsumer(prepared.requestPath, prepared.denyNetwork);
    const receipt = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(receipt).toMatchObject({
      schema_version: 1,
      kind: "provider_preflight_replay_receipt",
      provider_port: "absent",
      physical_calls: 0,
      key_count: prepared.fixture.keys.length,
      request_manifest_sha256: prepared.manifest.request_manifest_sha256,
      cache_manifest_sha256: prepared.fixture.manifestSha256
    });
    await expect(runReplayConsumer(
      prepared.requestPath,
      prepared.denyNetwork,
      { OFFICIAL_API_GARDEN_API_KEY: "must-not-reach-replay" }
    )).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining("credentialless and cache-only")
    });
  }, 20_000);

  it("rejects self-consistent key, window, route, and manifest-digest tampering", async () => {
    const prepared = await prepareCanonicalProcessFixture(root);
    const firstKey = prepared.fixture.keys[0]!;
    await expectTamperRejected(prepared, "limit", (body) => {
      body.request.limit = 100;
      body.request.requestedKeys = [firstKey];
      body.canonical_keys = canonicalBinding([firstKey]);
    }, "window");
    await expectTamperRejected(prepared, "offset", (body) => {
      body.request.offset = 99;
    }, "window");
    await expectTamperRejected(prepared, "route", (body) => {
      body.request.providerRoute = "https://other-provider.invalid/v1";
    }, "cache authority");
    await expectTamperRejected(prepared, "digest", (body) => {
      body.request.worker = true;
    }, "digest", false);
  }, 20_000);
});

interface ReplayManifestBody {
  schema_version: number;
  kind: string;
  request: Record<string, unknown> & {
    requestedKeys: string[];
    limit: number;
    offset: number;
    providerRoute: string;
    worker: boolean;
  };
  canonical_keys: { count: number; key_set_sha256: string };
  cache_authority: Record<string, unknown>;
  dataset_authority: Record<string, unknown>;
}

type ReplayManifest = ReplayManifestBody & { request_manifest_sha256: string };

interface PreparedCanonicalProcessFixture {
  readonly fixture: CanonicalReplayFixture;
  readonly requestPath: string;
  readonly denyNetwork: string;
  readonly manifest: ReplayManifest;
}

interface CanonicalReplayFixture {
  readonly cacheRoot: string;
  readonly dataDir: string;
  readonly pinnedMetaRoot: string;
  readonly datasetRevision: string;
  readonly keys: readonly string[];
  readonly manifestSha256: string;
  readonly contentClosureSha256: string;
}

async function prepareCanonicalProcessFixture(
  root: string
): Promise<PreparedCanonicalProcessFixture> {
  const fixture = await writeCanonicalReplayFixture(root);
  const requestPath = path.join(root, "canonical-request.json");
  const denyNetwork = path.join(root, "deny-network.cjs");
  await writeDenyNetwork(denyNetwork);
  await execFileAsync(process.execPath, [
    helper, requestPath, fixture.datasetRevision,
    computeSystemPromptSha256(OFFICIAL_API_SYSTEM_PROMPT),
    fixture.cacheRoot, "1", "0", PROVIDER, MODEL, PROFILE,
    fixture.dataDir, fixture.pinnedMetaRoot
  ], { timeout: 20_000 });
  const manifest = JSON.parse(await readFile(requestPath, "utf8")) as ReplayManifest;
  return { fixture, requestPath, denyNetwork, manifest };
}

async function writeDenyNetwork(path: string): Promise<void> {
  await writeFile(path, [
    "globalThis.fetch = () => { throw new Error('network adapter is unreachable'); };",
    "const http = require('node:http');",
    "const https = require('node:https');",
    "http.request = () => { throw new Error('http network is unreachable'); };",
    "https.request = () => { throw new Error('https network is unreachable'); };",
    ""
  ].join("\n"));
}

function expectManifestMatchesFixture(
  manifest: ReplayManifest,
  fixture: CanonicalReplayFixture
): void {
  expect(fixture.keys.length).toBeGreaterThan(1);
  expect(manifest.request.requestedKeys).toEqual(fixture.keys);
  expect(manifest.canonical_keys).toEqual(canonicalBinding(fixture.keys));
  expect(manifest.cache_authority).toMatchObject({
    manifest_sha256: fixture.manifestSha256,
    content_closure_sha256: fixture.contentClosureSha256
  });
}

async function runReplayConsumer(
  requestPath: string,
  denyNetwork: string,
  overrides: NodeJS.ProcessEnv = {}
) {
  return await execFileAsync(process.execPath, [
    bin, "provider-preflight", "--mode", "replay", "--request-manifest", requestPath
  ], {
    env: {
      ...process.env,
      NODE_OPTIONS: `--require=${denyNetwork}`,
      ALAYA_BENCH_ALLOW_LIVE_EXTRACTION: "0",
      ALAYA_OFFICIAL_GARDEN_SECRET_REF: "",
      ALAYA_OFFICIAL_GARDEN_API_KEY: "",
      OFFICIAL_API_GARDEN_API_KEY: "",
      ALAYA_QA_API_KEY: "",
      ALAYA_GARDEN_OPENAI_SECRET_REF: "",
      ALAYA_CONFLICT_LLM_PROVIDER_URL: "",
      ALAYA_CONFLICT_LLM_API_KEY: "",
      ...overrides
    },
    timeout: 20_000
  });
}

async function expectTamperRejected(
  prepared: PreparedCanonicalProcessFixture,
  name: string,
  mutate: (body: ReplayManifestBody) => void,
  message: string,
  resign = true
): Promise<void> {
  const { request_manifest_sha256: originalDigest, ...body } = structuredClone(
    prepared.manifest
  );
  mutate(body);
  const tampered = resign ? sealManifest(body) : {
    ...body, request_manifest_sha256: originalDigest
  };
  const path = `${prepared.requestPath}.${name}`;
  await writeFile(path, `${JSON.stringify(tampered)}\n`);
  await expect(runReplayConsumer(path, prepared.denyNetwork)).rejects.toMatchObject({
    code: 2,
    stderr: expect.stringContaining(message)
  });
}

function canonicalBinding(keys: readonly string[]) {
  return { count: keys.length, key_set_sha256: computeExtractionKeySetSha256(keys) };
}

function sealManifest(body: ReplayManifestBody): ReplayManifest {
  return {
    ...body,
    request_manifest_sha256: createHash("sha256")
      .update(JSON.stringify(body), "utf8")
      .digest("hex")
  };
}

async function writeCanonicalReplayFixture(root: string): Promise<CanonicalReplayFixture> {
  const dataDir = path.join(root, "data");
  const pinnedMetaRoot = path.join(root, "meta");
  const cacheRoot = path.join(root, "cache");
  await Promise.all([
    mkdir(dataDir, { recursive: true }),
    mkdir(pinnedMetaRoot, { recursive: true }),
    mkdir(cacheRoot, { recursive: true })
  ]);
  await writeLongMemEvalFixtureDataset({
    variant: "longmemeval_s",
    dataDir,
    pinnedMetaRoot,
    questions: [buildLongMemEvalFixtureQuestion("q001", "session-q001")]
  });
  const window = await prepareExtractionFillWindow({
    variant: "longmemeval_s", limit: 1, offset: 0, dataDir, pinnedMetaRoot
  }, undefined);
  const keys = [...new Set(requiredExtractionCacheKeys({
    model: MODEL,
    requestProfile: PROFILE,
    systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
    requiredTurnContents: window.distinctTurns,
    requiredExtractionTurns: window.distinctExtractionTurns
  }))].sort();
  const authority = writeSealedCache(cacheRoot, window.datasetRevision, keys);
  return {
    cacheRoot, dataDir, pinnedMetaRoot, datasetRevision: window.datasetRevision, keys,
    ...authority
  };
}

function writeSealedCache(
  cacheRoot: string,
  datasetRevision: string,
  keys: readonly string[]
): { readonly manifestSha256: string; readonly contentClosureSha256: string } {
  const rawJson = '{"signals":[]}';
  const inspected = inspectExtractionRawJson(rawJson);
  for (const key of keys) {
    writeCachedExtraction(cacheRoot, key, {
      model: MODEL, request_profile: PROFILE, cache_key: key, raw_json: rawJson,
      extracted_at: "2026-08-19T00:00:00.000Z",
      response_metadata: { finish_reason: "stop" }
    });
  }
  const entries = keys.map((cacheKey) => ({
    cacheKey, model: MODEL, requestProfile: PROFILE, ...inspected
  }));
  const contentClosureSha256 = computeExtractionContentClosureSha256(entries);
  writeExtractionCacheManifest(cacheRoot, manifestFor({
    extraction_model: MODEL, model_family: MODEL, request_profile: PROFILE,
    provider_url: PROVIDER, dataset_revision: datasetRevision,
    requested_turns: keys.length, cached_turns: keys.length, coverage: 1,
    fill_status: "complete", window_offset: 0, window_limit: 1,
    expected_turns: keys.length,
    expected_key_set_sha256: computeExtractionKeySetSha256(keys),
    content_closure_sha256: contentClosureSha256,
    content_closure_index: Object.fromEntries(keys.map((key) => [key, [
      inspected.rawJsonSha256, inspected.rawSignalCount, inspected.parsedDraftCount
    ]]))
  }));
  const identity = readExtractionCacheManifestIdentity(cacheRoot)!;
  return { manifestSha256: identity.manifestSha256, contentClosureSha256 };
}
import { createHash } from "node:crypto";
