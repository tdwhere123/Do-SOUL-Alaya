import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  capabilitiesAreCompatible,
  resolveExtractionCapability,
  supplementKey
} from "../../../runs/extraction/cache/semantic-artifact/capability.js";
import { fulfillAssertionCapability } from
  "../../../runs/extraction/cache/semantic-artifact/fulfill.js";
import { inspectSemanticArtifact } from
  "../../../runs/extraction/cache/semantic-artifact/store.js";
import { shadowLazyF3Fulfillment } from
  "../../../runs/extraction/cache/semantic-artifact/lazy-f3-shadow.js";
import {
  assertRecallZeroLiveExtraction,
  parseExtractionBenchMode
} from "../../../runs/extraction/cache/semantic-artifact/bench-mode.js";
import {
  createOfflineSemanticEnvelope,
  createOfflineSemanticReplay,
  createOfflineSemanticReplayForTasks
} from "../../../runs/extraction/fill/semantic-fill-envelope.js";
import {
  SEMANTIC_CAPABILITY as CAP,
  TOKEN_AWARE_POLICY,
  semanticTask,
  semanticTasks
} from "./semantic-artifact-fixture.js";

const KEY = semanticTask().semanticKey;
const ENVELOPE = createOfflineSemanticEnvelope({
  maxCalls: 2,
  maxFailures: 2,
  transportPolicy: TOKEN_AWARE_POLICY
});

describe("capability catalog", () => {
  it("matches requirements by set inclusion and rejects unknown ids", () => {
    expect(capabilitiesAreCompatible([CAP], [CAP])).toBe(true);
    expect(capabilitiesAreCompatible(["temporal_validity:v1"], [CAP])).toBe(false);
    expect(() => resolveExtractionCapability("nope:v1")).toThrow(/unknown extraction capability/u);
    expect(supplementKey(KEY, CAP)).toBe(`${KEY}:${CAP}`);
  });
});

describe("lazy F3 fulfillment shadow", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "fulfill-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it("keeps unavailable explicit and quarantined repeats at zero calls", async () => {
    const task = semanticTask();
    const coldMiss = await fulfillAssertionCapability({ root, task, envelope: ENVELOPE });
    expect(coldMiss).toMatchObject({ state: "unavailable", calls: 0 });
    const replay = createOfflineSemanticReplayForTasks({
      tasks: [task], transportPolicy: TOKEN_AWARE_POLICY,
      result: { kind: "raw", rawJson: '{"signals":[]}' }
    });
    const empty = await fulfillAssertionCapability({
      root, task, envelope: ENVELOPE, transport: replay
    });
    expect(empty).toMatchObject({ state: "unavailable", calls: 1 });
    const again = await fulfillAssertionCapability({
      root, task, envelope: ENVELOPE, transport: replay
    });
    expect(again).toMatchObject({ state: "unavailable", calls: 0 });
  });

  it("shares one call budget across coalesced shadow demand", async () => {
    const tasks = semanticTasks(["I moved to Berlin.", "I moved to Paris."]);
    const report = await shadowLazyF3Fulfillment({
      root,
      demand: [tasks[0]!, tasks[0]!, tasks[1]!],
      envelope: createOfflineSemanticEnvelope({
        maxCalls: 1, maxFailures: 2, transportPolicy: TOKEN_AWARE_POLICY
      }),
      transport: createOfflineSemanticReplay({
        defaultResult: { kind: "failure", reason: "offline" }
      })
    });
    expect(report.coldCalls).toBe(1);
    expect(report.revealed).toHaveLength(3);
  });

  it("returns unavailable for an unsupported capability without throwing", async () => {
    const result = await fulfillAssertionCapability({
      root,
      task: semanticTask("I moved to Berlin.", { capability: "not-a-capability:v1" }),
      envelope: ENVELOPE
    });
    expect(result).toMatchObject({
      state: "unavailable",
      capability: "not-a-capability:v1",
      calls: 0
    });
    expect(result.reason).toMatch(/unknown extraction capability/u);
  });

  it("does not mint availability from a replayed provider failure", async () => {
    const result = await fulfillAssertionCapability({
      root,
      task: semanticTask(),
      envelope: createOfflineSemanticEnvelope({
        maxCalls: 1, maxFailures: 1, transportPolicy: TOKEN_AWARE_POLICY
      }),
      transport: createOfflineSemanticReplay({
        defaultResult: { kind: "failure", reason: "provider" }
      })
    });
    expect(result.state).toBe("failed");
  });

  it("does not swap the captured demand when the caller mutates its task during await", async () => {
    const task = semanticTask();
    const originalKey = task.semanticKey;
    const transport = createOfflineSemanticReplayForTasks({
      tasks: [task],
      transportPolicy: TOKEN_AWARE_POLICY,
      result: {
        kind: "raw",
        rawJson: JSON.stringify({ signals: [{
          object_kind: "fact",
          confidence: 0.9,
          matched_text: task.text.replace(/^(?:User|Assistant): /u, ""),
          source_locator: {
            contract_version: task.binding.locator.contract_version,
            kind: "assertion_catalog",
            assertion_id: task.assertionId
          }
        }] })
      }
    });
    const pending = fulfillAssertionCapability({
      root, task, envelope: ENVELOPE, transport
    });
    const missingKey = "bb".repeat(32);
    (task as unknown as { semanticKey: string }).semanticKey = missingKey;

    await expect(pending).resolves.toMatchObject({
      state: "materialized-now",
      semanticKey: originalKey,
      capability: CAP,
      calls: 1
    });
    expect(inspectSemanticArtifact(root, originalKey, CAP).status).toBe("provider_backed");
    expect(inspectSemanticArtifact(root, missingKey, CAP).status).toBe("missing");
  });

  it("propagates cancellation across bounded fulfillment without minting availability", async () => {
    const controller = new AbortController();
    const transport = createOfflineSemanticReplay({
      defaultResult: { kind: "failure", reason: "provider" },
      faultHooks: { afterPack: () => controller.abort() }
    });
    await expect(fulfillAssertionCapability({
      root,
      task: semanticTask(),
      envelope: ENVELOPE,
      transport,
      signal: controller.signal
    })).rejects.toThrow(/aborted/u);
  });

  it("propagates cancellation through the shadow before warm replay", async () => {
    const controller = new AbortController();
    await expect(shadowLazyF3Fulfillment({
      root,
      demand: [semanticTask()],
      envelope: ENVELOPE,
      transport: createOfflineSemanticReplay({
        defaultResult: { kind: "failure", reason: "provider" },
        faultHooks: { afterPack: () => controller.abort() }
      }),
      signal: controller.signal
    })).rejects.toThrow(/aborted/u);
  });
});

describe("benchmark modes", () => {
  it("keeps precomputed_full and lazy_field distinct and fail-closes mixed identity", () => {
    expect(parseExtractionBenchMode({
      mode: "precomputed_full", corpusIdentity: "corpus", completeAuthority: true
    }).mode).toBe("precomputed_full");
    expect(parseExtractionBenchMode({
      mode: "lazy_field", f0f2SubstrateIdentity: "f0f2",
      startingCacheIdentity: "cache", capabilityPolicy: [CAP], maxCalls: 0
    }).mode).toBe("lazy_field");
    expect(() => parseExtractionBenchMode({ mode: "precomputed_full" }))
      .toThrow(/complete extraction authority/u);
    expect(() => parseExtractionBenchMode({ mode: "lazy_field" })).toThrow(/incomplete/u);
  });

  it("fails a Recall campaign on any live extraction attempt", () => {
    expect(() => assertRecallZeroLiveExtraction({
      providerExecutorEntries: 1, extractionWrites: 0
    })).toThrow(/live extraction/u);
    expect(() => assertRecallZeroLiveExtraction({
      providerExecutorEntries: 0, extractionWrites: 0
    })).not.toThrow();
  });
});
