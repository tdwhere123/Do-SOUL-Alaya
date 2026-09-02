import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildOfficialApiExtractionRequests } from "@do-soul/alaya-soul";
import { convertLegacyExtractionShard } from "../../../runs/extraction/cache/semantic-artifact/legacy-convert.js";
import { fulfillAssertionCapability } from "../../../runs/extraction/cache/semantic-artifact/fulfill.js";
import {
  assertRecallZeroLiveExtraction,
  parseExtractionBenchMode
} from "../../../runs/extraction/cache/semantic-artifact/bench-mode.js";
import { inspectSemanticArtifact } from "../../../runs/extraction/cache/semantic-artifact/store.js";
import type { SemanticFillTask } from "../../../runs/extraction/fill/semantic-fill-executor.js";

const KEY = "ab".repeat(32);
const CAP = "official_api_signals:v1";

describe("E10 semantic substrate integration", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "e10-substrate-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("converts fail-closed then fulfills missing-only without live extraction", () => {
    const request = buildOfficialApiExtractionRequests("I moved to Berlin.", [
      { role: "user", content: "I moved to Berlin." }
    ])[0]!;
    const conversion = convertLegacyExtractionShard({
      entry: {
        model: "mimo-v2.5",
        request_profile: "mimo-v2.5-nonthinking-v1",
        cache_key: "ef".repeat(32),
        raw_json: '{"signals":[]}',
        extracted_at: "2026-08-23T10:07:08.564Z"
      },
      request,
      sourceBindings: [{
        semanticKey: KEY,
        sourceCorpusIdentity: request.source_corpus_identity,
        sourceTextDigest: "22".repeat(32),
        locator: {
          contract_version: 2,
          kind: "assertion_catalog",
          assertion_id: request.source_assertions[0]!.assertion_id,
          start: 0,
          end: 8
        }
      }],
      semanticContract: "alaya.assertion_semantic_identity.v1",
      modelFamily: "mimo-v2.5"
    });
    expect(conversion.converted).toEqual([]);
    expect(conversion.unresolved[0]?.reason).toMatch(/not assertion-empty/u);

    const fillTask: SemanticFillTask = {
      semanticKey: KEY,
      capability: CAP,
      semanticContract: "alaya.assertion_semantic_identity.v1",
      modelFamily: "mimo-v2.5",
      modelId: "mimo-v2.5",
      binding: {
        semanticKey: KEY,
        sourceCorpusIdentity: request.source_corpus_identity,
        sourceTextDigest: "22".repeat(32),
        locator: {
          contract_version: 2,
          kind: "assertion_catalog",
          assertion_id: 1,
          start: 0,
          end: 8
        }
      }
    };
    const envelope = { mode: "offline-only" as const, maxCalls: 1, maxFailures: 1 };
    const fulfilled = fulfillAssertionCapability({
      root,
      task: fillTask,
      envelope,
      transport: { complete: () => ({ kind: "raw", rawJson: '{"signals":[]}' }) }
    });
    expect(fulfilled.state).toBe("materialized-now");
    expect(inspectSemanticArtifact(root, KEY, CAP).status).toBe("provider_backed");
    expect(parseExtractionBenchMode({
      mode: "lazy_field",
      f0f2SubstrateIdentity: "f0f2",
      startingCacheIdentity: "cache",
      capabilityPolicy: [CAP],
      maxCalls: 0
    }).mode).toBe("lazy_field");
    expect(() => assertRecallZeroLiveExtraction({
      providerExecutorEntries: 0,
      extractionWrites: 0
    })).not.toThrow();
  });
});
