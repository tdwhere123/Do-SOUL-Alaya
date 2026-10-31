import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SOURCE_STATEMENTS_PROMPT } from "@do-soul/alaya-soul";
import { createCachingSignalExtractor } from "../../../runs/compile-seed.js";
import { computeCacheKey } from "../../../runs/compile-seed/cache/cache-key.js";
import {
  inspectCachedExtraction, listExtractionCacheShardKeys, readCachedEntry, writeCachedExtraction
} from "../../../runs/compile-seed/cache/cache-shard.js";
import {
  extractionAdmissionGenerationSha256, extractionCacheManifestPath,
  EXTRACTION_ADMISSION_GENERATION_STATEMENT, readExtractionCacheManifest,
  writeExtractionCacheManifest
} from "../../../runs/extraction/cache/extraction-cache-manifest.js";
import { runExtractionFill } from "../../../runs/extraction/extraction-fill.js";
import { sourceStatementRequests } from "../../../runs/extraction/source-statement-request.js";
import {
  fixtureAttemptAuthority, providerBackedResponseResult, TEST_EXTRACTION_PROVIDER_URL,
  writeExtractionCacheTestManifest
} from "../extraction/extraction-cache-test-fixture.js";
import { authorizedHttpExtractor, writeAuthorizedFixtureReceipt } from "./authority-runtime/fixture.js";
import {
  buildExtractionFillQuestion, buildGroundedInterpretationResponse, EXTRACTION_FILL_VARIANT,
  registerExtractionFillHooks
} from "./fixture.js";

const MODEL = "gpt-5.4-mini";
const PROFILE = "provider-default-v1" as const;
const HOST = [
  { message_id: "m0", role: "user" as const, content: "Recorded event." },
  { message_id: "m1", role: "assistant" as const, content: "Acknowledged." }
];

let cacheRoot: string;
let dataDir: string;
let pinnedMetaRoot: string;
const writeFixtureDataset = registerExtractionFillHooks((roots) => {
  ({ cacheRoot, dataDir, pinnedMetaRoot } = roots);
});

afterEach(() => vi.unstubAllGlobals());

describe("current statement admission generation", () => {
  it("keeps versioned statement hits after fill-window mutation and rejects dataset revision drift", async () => {
    const key = await persistSession();
    const manifest = readExtractionCacheManifest(cacheRoot)!;
    writeExtractionCacheManifest(cacheRoot, {
      ...manifest, fill_status: "in_progress", window_offset: 0, window_limit: 2,
      expected_turns: 2, requested_turns: 2, cached_turns: 1, coverage: 0.5,
      expected_key_set_sha256: "c".repeat(64)
    });
    expect(inspectCachedExtraction(cacheRoot, key, MODEL, PROFILE)).toMatchObject({ status: "hit" });
    writeExtractionCacheManifest(cacheRoot, {
      ...readExtractionCacheManifest(cacheRoot)!, dataset_revision: "foreign-dataset"
    });
    expect(inspectCachedExtraction(cacheRoot, key, MODEL, PROFILE)).toMatchObject({
      status: "invalid", reason: expect.stringContaining("generation binding mismatch")
    });
  });

  it("rejects a caller-supplied statement contract whose owner generation does not match", async () => {
    const key = await persistSession();
    const cached = readCachedEntry(cacheRoot, key, MODEL, PROFILE);
    if (cached.status !== "hit") throw new Error("expected persisted statement");
    writeCachedExtraction(cacheRoot, key, {
      ...cached.entry,
      admission_identity: {
        contract: EXTRACTION_ADMISSION_GENERATION_STATEMENT,
        generation_sha256: extractionAdmissionGenerationSha256(readExtractionCacheManifest(cacheRoot)!),
        request_key: cached.entry.admission_identity!.request_key,
        raw_json_sha256: cached.entry.admission_identity!.raw_json_sha256
      }
    });
    expect(inspectCachedExtraction(cacheRoot, key, MODEL, PROFILE)).toMatchObject({
      status: "invalid", reason: expect.stringContaining("generation binding mismatch")
    });
  });

  it("rejects unknown identity contracts and raw digest tampering as invalid, not missing", async () => {
    const key = await persistSession();
    const cached = readCachedEntry(cacheRoot, key, MODEL, PROFILE);
    if (cached.status !== "hit") throw new Error("expected persisted statement");
    writeCachedExtraction(cacheRoot, key, {
      ...cached.entry,
      admission_identity: { ...cached.entry.admission_identity!, contract: "forged-contract" as never }
    });
    expect(inspectCachedExtraction(cacheRoot, key, MODEL, PROFILE)).toMatchObject({
      status: "invalid", reason: expect.stringContaining("admission_identity")
    });
    writeCachedExtraction(cacheRoot, key, cached.entry);
    writeCachedExtraction(cacheRoot, key, {
      ...cached.entry,
      admission_identity: { ...cached.entry.admission_identity!, raw_json_sha256: "0".repeat(64) }
    });
    expect(inspectCachedExtraction(cacheRoot, key, MODEL, PROFILE)).toMatchObject({
      status: "invalid", reason: expect.stringContaining("generation binding mismatch")
    });
  });

  it("still reads unversioned statements in the same window and refuses reframe before mutating the manifest", async () => {
    await writeFixtureDataset([
      buildExtractionFillQuestion("q001", "User: alpha", "User: decoy"),
      buildExtractionFillQuestion("q002", "User: beta", "User: distraction")
    ]);
    const authorityReceiptPath = await writeAuthorizedFixtureReceipt(
      { cacheRoot, dataDir, pinnedMetaRoot }, { limit: 1 });
    await runExtractionFill({
      variant: EXTRACTION_FILL_VARIANT, limit: 1, cacheRoot, dataDir, pinnedMetaRoot,
      authorityReceiptPath, extractorFactory: authorizedHttpExtractor().factory, log: () => undefined
    });
    demoteToUnversioned();
    const key = listExtractionCacheShardKeys(cacheRoot)[0]!;
    expect(inspectCachedExtraction(cacheRoot, key, MODEL, PROFILE)).toMatchObject({ status: "hit" });
    const before = readFileSync(extractionCacheManifestPath(cacheRoot));
    await expect(runExtractionFill({
      variant: EXTRACTION_FILL_VARIANT, cacheRoot, dataDir, pinnedMetaRoot, questionBatchLimit: 1,
      extractorFactory: () => ({ extract: async () => {
        throw new Error("cached question must not call the delegate");
      } }),
      log: () => undefined
    })).rejects.toThrow(/unversioned statement cache cannot reframe the fill window/u);
    expect(readFileSync(extractionCacheManifestPath(cacheRoot))).toEqual(before);
    expect(readExtractionCacheManifest(cacheRoot)).toMatchObject({ window_limit: 1, fill_status: "complete" });
  });
});

async function persistSession(): Promise<string> {
  writeExtractionCacheTestManifest({ cacheRoot, model: MODEL, systemPrompt: SOURCE_STATEMENTS_PROMPT });
  const request = sourceStatementRequests(HOST)[0]!;
  const extractor = createCachingSignalExtractor({
    cacheRoot,
    config: {
      model: MODEL, modelFamily: MODEL, providerUrl: TEST_EXTRACTION_PROVIDER_URL,
      requestProfile: PROFILE, sourcePacking: "session-statements"
    },
    delegate: { extract: input => providerBackedResponseResult(input, buildGroundedInterpretationResponse(input.userPrompt)) },
    ...fixtureAttemptAuthority({ cacheRoot, model: MODEL, requestProfile: PROFILE })
  });
  await extractor.extract({ systemPrompt: SOURCE_STATEMENTS_PROMPT, userPrompt: request.userPrompt });
  return computeCacheKey(MODEL, PROFILE, SOURCE_STATEMENTS_PROMPT, request.userPrompt);
}

function demoteToUnversioned(): void {
  const windowed = extractionAdmissionGenerationSha256(readExtractionCacheManifest(cacheRoot)!);
  for (const key of listExtractionCacheShardKeys(cacheRoot)) {
    const cached = readCachedEntry(cacheRoot, key, MODEL, PROFILE);
    if (cached.status !== "hit" || cached.entry.source_statement === undefined) continue;
    const identity = cached.entry.admission_identity;
    if (identity === undefined) throw new Error("expected admission identity");
    writeCachedExtraction(cacheRoot, key, {
      ...cached.entry,
      admission_identity: {
        generation_sha256: windowed,
        request_key: identity.request_key,
        raw_json_sha256: identity.raw_json_sha256
      }
    });
  }
}
