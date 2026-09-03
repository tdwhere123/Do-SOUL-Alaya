import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fulfillAssertionCapability } from
  "../../../runs/extraction/fill/fulfillment/fulfill.js";
import {
  assertRecallZeroLiveExtraction,
  parseExtractionBenchMode
} from "../../../runs/extraction/cache/semantic-artifact/bench-mode.js";
import { inspectSemanticArtifact } from
  "../../../runs/extraction/cache/semantic-artifact/store.js";
import { computeExtractionKeySetSha256 } from
  "../../../runs/extraction/content-closure.js";
import {
  createOfflineSemanticEnvelope,
  createOfflineSemanticReplayForTasks
} from "../../../runs/extraction/fill/semantic-fill-envelope.js";
import {
  assertLazySemanticAuthorityMatchesExtraction,
  captureSemanticRunSourceAuthority,
  SemanticRunSourceAuthoritySchema
} from "../../../runs/extraction/fill/semantic-fill-authority.js";
import { collectSemanticFillTasks } from
  "../../../runs/extraction/fill/semantic-workset-tasks.js";
import { writeCompletedExtractionCacheFixture } from
  "./completed-extraction-cache-fixture.js";
import { readExtractionCacheManifestIdentity } from
  "../../../runs/extraction/cache/extraction-cache-manifest.js";
import type { PreparedExtractionFill } from
  "../../../runs/extraction/fill/fill-preparation.js";
import {
  SEMANTIC_CAPABILITY as CAP,
  TOKEN_AWARE_POLICY,
  semanticTask
} from "./semantic-artifact-fixture.js";

describe("E10 semantic substrate integration", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "e10-substrate-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("keeps unproved empty fill unresolved and separately attributes lazy mode", async () => {
    const task = semanticTask();
    const fulfilled = await fulfillAssertionCapability({
      root,
      task,
      envelope: createOfflineSemanticEnvelope({
        maxCalls: 1, maxFailures: 1, transportPolicy: TOKEN_AWARE_POLICY
      }),
      transport: createOfflineSemanticReplayForTasks({
        tasks: [task], transportPolicy: TOKEN_AWARE_POLICY,
        result: { kind: "raw", rawJson: '{"signals":[]}' }
      })
    });
    expect(fulfilled.state).toBe("unavailable");
    expect(inspectSemanticArtifact(root, task.semanticKey, CAP).status).toBe("quarantined");
    expect(parseExtractionBenchMode({
      mode: "lazy_field",
      f0f2SubstrateIdentity: "f0f2",
      startingCacheIdentity: "cache",
      capabilityPolicy: [CAP],
      maxCalls: 0
    }).mode).toBe("lazy_field");
    expect(() => assertRecallZeroLiveExtraction({
      providerExecutorEntries: 0, extractionWrites: 0
    })).not.toThrow();
    expect(() => assertRecallZeroLiveExtraction({
      providerExecutorEntries: fulfilled.calls, extractionWrites: 0
    })).toThrow(/live extraction/u);
  });

  it("accepts sparse demand against a complete substrate and fail-closes a foreign key", () => {
    const task = semanticTask();
    const demandKeys = [...task.sourceAuthority.substrateCacheKeys];
    const emptyWorkKey = "ab".repeat(32);
    const fullKeys = [...demandKeys, emptyWorkKey].sort();
    const fullIndex = Object.fromEntries(fullKeys.map((cacheKey) => [
      cacheKey, ["aa".repeat(32), 0, 0] as const
    ]));
    const substrateManifest = {
      ...task.sourceAuthority.substrateManifest,
      expectedTurns: fullKeys.length,
      expectedKeySetSha256: computeExtractionKeySetSha256(fullKeys),
      contentClosureIndexSha256: createHash("sha256")
        .update(JSON.stringify(fullIndex), "utf8").digest("hex")
    };
    const captured = captureSemanticRunSourceAuthority([{
      ...task,
      sourceAuthority: { ...task.sourceAuthority, substrateManifest }
    }]);
    expect(SemanticRunSourceAuthoritySchema.parse(captured)).toEqual(captured);
    expect(computeExtractionKeySetSha256(
      captured.sourceCorpora.flatMap((entry) => entry.substrateCacheKeys)
    )).not.toBe(substrateManifest.expectedKeySetSha256);
    expect(captured.sourceCorpora.flatMap((entry) => entry.substrateCacheKeys).length)
      .toBeLessThan(substrateManifest.expectedTurns);

    const extraction = {
      schema_version: 3 as const,
      manifest_sha256: substrateManifest.manifestSha256,
      dataset: substrateManifest.dataset,
      dataset_revision: substrateManifest.datasetRevision,
      extraction_model: substrateManifest.extractionModel,
      model_family: substrateManifest.modelFamily,
      request_profile: substrateManifest.requestProfile,
      system_prompt_sha256: substrateManifest.systemPromptSha256,
      cache_key_algo: substrateManifest.cacheKeyAlgorithm,
      expected_turns: substrateManifest.expectedTurns,
      expected_key_set_sha256: substrateManifest.expectedKeySetSha256,
      content_closure_sha256: substrateManifest.contentClosureSha256,
      content_closure_index: fullIndex,
      window_offset: substrateManifest.windowOffset,
      window_limit: substrateManifest.windowLimit
    };
    expect(() => assertLazySemanticAuthorityMatchesExtraction({
      receipt: { sourceAuthority: captured },
      extraction
    })).not.toThrow();

    const foreign = SemanticRunSourceAuthoritySchema.parse({
      ...captured,
      sourceCorpora: captured.sourceCorpora.map((entry) => ({
        ...entry,
        substrateCacheKeys: [...entry.substrateCacheKeys, "ff".repeat(32)].sort()
      }))
    });
    expect(() => assertLazySemanticAuthorityMatchesExtraction({
      receipt: { sourceAuthority: foreign },
      extraction
    })).toThrow(/foreign source corpus substrate/u);
  });

  it("does not mint tasks for empty-work turns and fail-closes a foreign window key", () => {
    const datasetRevision = "dd".repeat(32);
    const workTurn = {
      turnContent: "I moved to Berlin.",
      turnMessages: [{
        message_id: "e10-berlin-m0",
        role: "user" as const,
        content: "I moved to Berlin."
      }]
    };
    const emptyTurn = { turnContent: "", turnMessages: [] as const };
    writeCompletedExtractionCacheFixture({
      cacheRoot: root,
      turnContents: [workTurn.turnContent, emptyTurn.turnContent],
      datasetRevision,
      windowOffset: 0,
      windowLimit: 2
    });
    const identity = readExtractionCacheManifestIdentity(root);
    if (identity === undefined || identity.manifest.schema_version !== 3) {
      throw new Error("completed substrate fixture is missing");
    }
    const prepared = {
      existingManifest: identity.manifest,
      pinnedManifestSha256: identity.manifestSha256,
      config: {
        model: identity.manifest.extraction_model,
        requestProfile: identity.manifest.request_profile,
        modelFamily: identity.manifest.model_family,
        providerUrl: identity.manifest.provider_url
      },
      datasetRevision
    } as PreparedExtractionFill;
    expect(collectSemanticFillTasks([emptyTurn], prepared)).toEqual([]);
    const tasks = collectSemanticFillTasks([workTurn, emptyTurn], prepared);
    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks.every((task) => task.sourceCorpus.includes("Berlin"))).toBe(true);
    const demandKeys = [...new Set(tasks.flatMap((task) => task.sourceAuthority.substrateCacheKeys))];
    expect(demandKeys.length).toBeLessThan(identity.manifest.expected_turns ?? 0);

    expect(() => collectSemanticFillTasks([{
      turnContent: "I moved to Mars.",
      turnMessages: [{
        message_id: "e10-mars-m0",
        role: "user",
        content: "I moved to Mars."
      }]
    }], prepared)).toThrow(/foreign/u);
  });
});
