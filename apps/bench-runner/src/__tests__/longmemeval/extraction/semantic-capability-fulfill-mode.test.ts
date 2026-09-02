import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  capabilitiesAreCompatible,
  resolveExtractionCapability,
  supplementKey
} from "../../../runs/extraction/cache/semantic-artifact/capability.js";
import { fulfillAssertionCapability } from "../../../runs/extraction/cache/semantic-artifact/fulfill.js";
import {
  assertRecallZeroLiveExtraction,
  parseExtractionBenchMode
} from "../../../runs/extraction/cache/semantic-artifact/bench-mode.js";
import type { SemanticFillTask } from "../../../runs/extraction/fill/semantic-fill-executor.js";

const KEY = "ab".repeat(32);
const CAP = "official_api_signals:v1";

function task(): SemanticFillTask {
  return {
    semanticKey: KEY,
    capability: CAP,
    semanticContract: "alaya.assertion_semantic_identity.v1",
    modelFamily: "mimo-v2.5",
    modelId: "mimo-v2.5",
    requestProfile: "mimo-v2.5-nonthinking-v1",
    providerUrlSha256: "44".repeat(32),
    assertionId: 1,
    text: "I moved to Berlin.",
    binding: {
      semanticKey: KEY,
      sourceCorpusIdentity: "11".repeat(32),
      sourceTextDigest: "22".repeat(32),
      locator: {
        contract_version: 2,
        kind: "assertion_catalog",
        assertion_id: 1,
        start: 0,
        end: 4
      }
    }
  };
}

describe("capability catalog", () => {
  it("matches requirements by set inclusion and rejects unknown ids", () => {
    expect(capabilitiesAreCompatible(["official_api_signals:v1"], ["official_api_signals:v1"])).toBe(true);
    expect(capabilitiesAreCompatible(["temporal_validity:v1"], ["official_api_signals:v1"])).toBe(false);
    expect(() => resolveExtractionCapability("nope:v1")).toThrow(/unknown extraction capability/u);
    expect(supplementKey(KEY, CAP)).toBe(`${KEY}:${CAP}`);
  });
});

describe("lazy F3 fulfillment shadow", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "fulfill-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("keeps unavailable explicit and warms to zero calls", () => {
    const envelope = { mode: "offline-only" as const, maxCalls: 2, maxFailures: 2 };
    const coldMiss = fulfillAssertionCapability({ root, task: task(), envelope });
    expect(coldMiss.state).toBe("unavailable");
    expect(coldMiss.calls).toBe(0);
    const empty = fulfillAssertionCapability({
      root,
      task: task(),
      envelope,
      transport: { complete: () => ({ kind: "raw", rawJson: '{"signals":[]}' }) }
    });
    expect(empty.state).toBe("unavailable");
    expect(empty.calls).toBe(1);
    const again = fulfillAssertionCapability({
      root,
      task: task(),
      envelope,
      transport: { complete: () => ({ kind: "raw", rawJson: '{"signals":[]}' }) }
    });
    expect(again.state).toBe("unavailable");
    expect(again.calls).toBe(0);
  });

  it("does not mint availability from provider failure", () => {
    const result = fulfillAssertionCapability({
      root,
      task: task(),
      envelope: { mode: "offline-only", maxCalls: 1, maxFailures: 1 },
      transport: { complete: () => ({ kind: "failure", reason: "provider" }) }
    });
    expect(result.state).toBe("failed");
  });
});

describe("benchmark modes", () => {
  it("keeps precomputed_full and lazy_field distinct and fail-closes mixed identity", () => {
    expect(parseExtractionBenchMode({
      mode: "precomputed_full",
      corpusIdentity: "corpus",
      completeAuthority: true
    }).mode).toBe("precomputed_full");
    expect(parseExtractionBenchMode({
      mode: "lazy_field",
      f0f2SubstrateIdentity: "f0f2",
      startingCacheIdentity: "cache",
      capabilityPolicy: [CAP],
      maxCalls: 0
    }).mode).toBe("lazy_field");
    expect(() => parseExtractionBenchMode({ mode: "precomputed_full" })).toThrow(/complete extraction authority/u);
    expect(() => parseExtractionBenchMode({ mode: "lazy_field" })).toThrow(/incomplete/u);
  });

  it("fails a Recall campaign on any live extraction attempt", () => {
    expect(() => assertRecallZeroLiveExtraction({
      providerExecutorEntries: 1,
      extractionWrites: 0
    })).toThrow(/live extraction/u);
    expect(() => assertRecallZeroLiveExtraction({
      providerExecutorEntries: 0,
      extractionWrites: 0
    })).not.toThrow();
  });
});
