import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReconciliationLlmDecisionPort } from "../reconciliation-llm-decision.js";

// invariant: covers the disk-cached garden-LLM reconciliation decision
// port — the null-credentials disable, the decision cache round trip,
// and the content-anchored cache target (a cache hit resolves the
// target back to the CURRENT candidate carrying that content, and drops
// the target when no current candidate matches).
// see also: apps/core-daemon/src/reconciliation-llm-decision.ts

const baseConfig = {
  providerUrl: "https://example.test/v1",
  model: "test-model",
  apiKey: "sk-test"
} as const;

describe("createReconciliationLlmDecisionPort", () => {
  let cacheRoot: string;

  beforeEach(() => {
    cacheRoot = mkdtempSync(join(tmpdir(), "recon-decision-cache-"));
  });

  afterEach(() => {
    rmSync(cacheRoot, { recursive: true, force: true });
  });

  it("returns null when no garden credentials are configured", () => {
    const port = createReconciliationLlmDecisionPort({
      config: { ...baseConfig, apiKey: null }
    });
    expect(port).toBeNull();
  });

  it("caches a decision and reuses it with zero further LLM calls", async () => {
    const llmComplete = vi.fn(async () =>
      JSON.stringify({ kind: "noop", target_object_id: "memory-a", reason: "dup" })
    );
    const port = createReconciliationLlmDecisionPort({
      config: baseConfig,
      cacheRoot,
      llmComplete
    });
    expect(port).not.toBeNull();

    const candidates = [{ objectId: "memory-a", content: "The user lives in Berlin" }];
    const first = await port!.decide({ incomingContent: "lives in Berlin", candidates });
    expect(first.kind).toBe("noop");
    expect(first.targetObjectId).toBe("memory-a");
    expect(llmComplete).toHaveBeenCalledTimes(1);

    const second = await port!.decide({ incomingContent: "lives in Berlin", candidates });
    expect(second.kind).toBe("noop");
    expect(second.targetObjectId).toBe("memory-a");
    // Served from disk — no second LLM call.
    expect(llmComplete).toHaveBeenCalledTimes(1);
  });

  it("content-anchored cache hit resolves the target to the current object_id", async () => {
    const llmComplete = vi.fn(async () =>
      JSON.stringify({ kind: "update", target_object_id: "memory-old", reason: "refine" })
    );
    const port = createReconciliationLlmDecisionPort({
      config: baseConfig,
      cacheRoot,
      llmComplete
    });

    const targetContent = "The user lives in Berlin";
    // Populate the cache keyed on the candidate set carrying memory-old.
    await port!.decide({
      incomingContent: "lives in Berlin since 2019",
      candidates: [{ objectId: "memory-old", content: targetContent }]
    });

    // Re-run: the same incoming + same candidate CONTENTS, but the row
    // now carries a different object_id (re-materialized). The cache hit
    // must resolve the target back to the CURRENT id, not the stale one.
    const hit = await port!.decide({
      incomingContent: "lives in Berlin since 2019",
      candidates: [{ objectId: "memory-new", content: targetContent }]
    });
    expect(hit.kind).toBe("update");
    expect(hit.targetObjectId).toBe("memory-new");
    expect(llmComplete).toHaveBeenCalledTimes(1);
  });

  it("drops the cached target when two candidates hold byte-identical content", async () => {
    // Two distinct rows carry the same content. A content-anchored cache
    // hit cannot tell which row the LLM judged — guessing one would be a
    // silent wrong-target durable mutation. The port must drop the target
    // (return undefined) so the core service degrades the verdict to ADD.
    const llmComplete = vi.fn(async () =>
      JSON.stringify({ kind: "update", target_object_id: "memory-a", reason: "refine" })
    );
    const port = createReconciliationLlmDecisionPort({
      config: baseConfig,
      cacheRoot,
      llmComplete
    });

    const sharedContent = "The user lives in Berlin";
    // Populate the cache. Two candidate rows already hold byte-identical
    // content; the LLM picked memory-a, the cache stores its content hash.
    const candidates = [
      { objectId: "memory-a", content: sharedContent },
      { objectId: "memory-b", content: sharedContent }
    ];
    const first = await port!.decide({
      incomingContent: "lives in Berlin since 2019",
      candidates
    });
    expect(first.kind).toBe("update");
    expect(first.targetObjectId).toBe("memory-a");

    // Re-run: same incoming + same candidate contents → cache hit. The
    // stored content hash now matches BOTH candidate rows; the target is
    // ambiguous and must be dropped rather than guessed.
    const hit = await port!.decide({
      incomingContent: "lives in Berlin since 2019",
      candidates
    });
    expect(hit.kind).toBe("update");
    expect(hit.targetObjectId).toBeUndefined();
    // Served from disk — no second LLM call.
    expect(llmComplete).toHaveBeenCalledTimes(1);
  });

  it("caches an ADD verdict with no target and round-trips it", async () => {
    const llmComplete = vi.fn(async () =>
      JSON.stringify({ kind: "add", reason: "distinct" })
    );
    const port = createReconciliationLlmDecisionPort({
      config: baseConfig,
      cacheRoot,
      llmComplete
    });

    const candidates = [{ objectId: "memory-a", content: "The user lives in Berlin" }];
    const first = await port!.decide({ incomingContent: "works in Munich", candidates });
    expect(first.kind).toBe("add");
    expect(first.targetObjectId).toBeUndefined();

    const second = await port!.decide({ incomingContent: "works in Munich", candidates });
    expect(second.kind).toBe("add");
    expect(second.targetObjectId).toBeUndefined();
    expect(llmComplete).toHaveBeenCalledTimes(1);
  });
});
