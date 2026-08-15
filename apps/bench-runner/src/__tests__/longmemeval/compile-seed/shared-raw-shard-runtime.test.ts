import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  buildOfficialApiExtractionRequests,
  buildOfficialApiSourceCorpus,
  OFFICIAL_API_SIGNAL_PARSER_SEMANTICS_VERSION,
  OFFICIAL_API_SOURCE_GROUNDING_SEMANTICS_VERSION,
  OFFICIAL_API_SYSTEM_PROMPT,
  stringifyOfficialApiExtractionRequest
} from "@do-soul/alaya-soul";
import { createCompileSeedRunner } from "../../../longmemeval/compile-seed.js";
import { computeCacheKey } from
  "../../../longmemeval/compile-seed/compile-seed-cache.js";
import { writeCachedExtraction } from
  "../../../longmemeval/compile-seed/cache/cache-shard.js";
import { readExtractionCacheManifestIdentity } from
  "../../../longmemeval/extraction/cache/extraction-cache-manifest.js";
import { createSourceAssertionSupplementReceipt } from
  "../../../longmemeval/extraction/cache/semantic-supplement/source-assertion-supplement.js";
import {
  TEST_EXTRACTION_PROVIDER_URL,
  writeExtractionCacheTestManifest
} from "../extraction/extraction-cache-test-fixture.js";
import { buildCompileSeedDaemon, makeSeed } from "./compile-seed-fixture.js";

const MODEL = "shared-inspection-model";
const REQUEST_PROFILE = "provider-default-v1" as const;
const TURN = "I use TypeScript. I avoid any.";
const TURN_MESSAGES = [
  { message_id: "m1", role: "user" as const, content: "I use TypeScript." },
  { message_id: "m2", role: "user" as const, content: "I avoid any." }
];

it("shares the verified primary shard through the real supplement chain", async () => {
  const root = await mkdtemp(join(tmpdir(), "shared-raw-runtime-"));
  const primaryCacheRoot = join(root, "primary");
  const sourceCacheRoot = join(root, "source");
  try {
    const fixture = writeRuntimeFixture(primaryCacheRoot, sourceCacheRoot);
    const runner = createCompileSeedRunner({
      cacheRoot: primaryCacheRoot,
      config: {
        providerUrl: TEST_EXTRACTION_PROVIDER_URL,
        model: MODEL,
        requestProfile: REQUEST_PROFILE,
        apiKey: null
      },
      skipPreflight: true,
      diagnosticDir: null,
      sourceAssertionSupplement: {
        receiptPath: fixture.receiptPath,
        sourceCacheRoot
      }
    });

    const result = await runner.seedTurn({
      daemon: buildCompileSeedDaemon((input) => makeSeed(input.distilledFact)),
      turnContent: TURN,
      turnMessages: TURN_MESSAGES,
      evidenceRefBase: "q1-s0-t0",
      seedIndex: 0,
      workspaceId: "ws-test",
      runId: "run-test"
    });

    expect(result.seeds).toHaveLength(2);
    expect(runner.stats.lastSemanticSupplementShards).toHaveLength(1);
    expect(runner.stats.rawShardInspection).toMatchObject({
      primary: { physicalReads: 1, parseMisses: 1, memoHits: 0 },
      supplement: { physicalReads: 1, parseMisses: 1, memoHits: 1 }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function writeRuntimeFixture(primaryCacheRoot: string, sourceCacheRoot: string) {
  writeManifest(primaryCacheRoot, TEST_EXTRACTION_PROVIDER_URL);
  writeManifest(sourceCacheRoot, "https://source-provider.invalid/v1");
  const primaryIdentity = requireIdentity(primaryCacheRoot);
  const sourceIdentity = requireIdentity(sourceCacheRoot);
  const request = requireSingleRequest();
  const cacheKey = computeCacheKey(
    MODEL,
    REQUEST_PROFILE,
    OFFICIAL_API_SYSTEM_PROMPT,
    stringifyOfficialApiExtractionRequest(request)
  );
  const primaryRawJson = envelope([signal(1, "I use TypeScript.")]);
  const sourceRawJson = envelope([
    signal(1, "I use TypeScript."),
    signal(2, "I avoid any.")
  ]);
  const sourceCorpus = buildOfficialApiSourceCorpus(TURN, TURN_MESSAGES);
  writeShard(primaryCacheRoot, cacheKey, primaryRawJson);
  writeShard(sourceCacheRoot, cacheKey, sourceRawJson);
  const receipt = createReceipt({
    primaryIdentity,
    sourceIdentity,
    request,
    cacheKey,
    sourceRawJson,
    primaryRawJson,
    sourceCorpus
  });
  const receiptPath = join(primaryCacheRoot, "supplement-receipt.json");
  writeFileSync(receiptPath, JSON.stringify(receipt), "utf8");
  return { receiptPath };
}

function createReceipt(input: {
  primaryIdentity: ReturnType<typeof requireIdentity>;
  sourceIdentity: ReturnType<typeof requireIdentity>;
  request: ReturnType<typeof requireSingleRequest>;
  cacheKey: string;
  sourceRawJson: string;
  primaryRawJson: string;
  sourceCorpus: string;
}) {
  return createSourceAssertionSupplementReceipt({
    createdAt: "2026-08-11T00:00:00.000Z",
    primaryIdentity: {
      manifestSha256: input.primaryIdentity.manifestSha256,
      model: MODEL,
      modelFamily: MODEL,
      requestProfile: REQUEST_PROFILE,
      systemPromptSha256: input.primaryIdentity.manifest.system_prompt_sha256,
      parserSemantics: OFFICIAL_API_SIGNAL_PARSER_SEMANTICS_VERSION,
      groundingSemantics: OFFICIAL_API_SOURCE_GROUNDING_SEMANTICS_VERSION
    },
    sourceIdentity: {
      manifestSha256: input.sourceIdentity.manifestSha256,
      model: MODEL,
      modelFamily: MODEL,
      requestProfile: REQUEST_PROFILE,
      systemPromptSha256: input.sourceIdentity.manifest.system_prompt_sha256
    },
    coverageAuditSha256: "a".repeat(64),
    groundingAuditSha256: "b".repeat(64),
    entries: [{
      primaryCacheKey: input.cacheKey,
      request: input.request,
      sourceCacheKey: input.cacheKey,
      sourceRawJson: input.sourceRawJson,
      primaryRawJson: input.primaryRawJson,
      sourceCorpus: input.sourceCorpus,
      anchorAssertionIds: [2],
      occurrenceCount: 1
    }]
  });
}

function requireSingleRequest() {
  const requests = buildOfficialApiExtractionRequests(TURN, TURN_MESSAGES);
  expect(requests).toHaveLength(1);
  const request = requests[0];
  if (request === undefined) throw new Error("test extraction request is missing");
  expect(request.source_assertions).toHaveLength(2);
  return request;
}

function writeManifest(cacheRoot: string, providerUrl: string): void {
  writeExtractionCacheTestManifest({
    cacheRoot,
    model: MODEL,
    providerUrl,
    systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
    requestProfile: REQUEST_PROFILE
  });
}

function requireIdentity(cacheRoot: string) {
  const identity = readExtractionCacheManifestIdentity(cacheRoot);
  if (identity === undefined) throw new Error("test manifest identity is missing");
  return identity;
}

function writeShard(cacheRoot: string, cacheKey: string, rawJson: string): void {
  writeCachedExtraction(cacheRoot, cacheKey, {
    model: MODEL,
    request_profile: REQUEST_PROFILE,
    cache_key: cacheKey,
    raw_json: rawJson,
    extracted_at: "2026-08-11T00:00:00.000Z"
  });
}

function envelope(signals: readonly ReturnType<typeof signal>[]): string {
  return JSON.stringify({ signals });
}

function signal(assertionId: number, matchedText: string) {
  return {
    signal_kind: "potential_claim",
    object_kind: "fact",
    confidence: 0.9,
    matched_text: matchedText,
    distilled_fact: matchedText,
    source_locator: {
      contract_version: 2,
      kind: "assertion_catalog",
      assertion_id: assertionId
    },
    semantic_factor_graph: {
      schema_version: 1,
      source_kind: "evidence",
      factors: [{
        factor_id: "f0",
        surface: matchedText,
        semantic_identity: matchedText.toLowerCase()
      }],
      variables: [],
      result_variable_ids: [],
      propositions: [{
        proposition_id: "p0",
        predicate_factor_id: "f0",
        arguments: [{
          position: 0,
          binding_identity: `assertion-${assertionId}`,
          reference_kind: "factor",
          reference_id: "f0"
        }]
      }]
    }
  };
}
