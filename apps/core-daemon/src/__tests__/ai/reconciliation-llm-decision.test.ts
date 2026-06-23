import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReconciliationLlmDecisionPort } from "../../ai/reconciliation-llm-decision.js";

// invariant: covers the disk-cached garden-LLM reconciliation decision
// port — the null-credentials disable, the decision cache round trip,
// and the content-anchored cache target (a cache hit resolves the
// target back to the CURRENT candidate carrying that content, and drops
// the target when no current candidate matches).
// see also: apps/core-daemon/src/ai/reconciliation-llm-decision.ts

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
    vi.restoreAllMocks();
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

  it("retries transient garden HTTP failures before parsing the decision", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("rate limited", {
        status: 429,
        statusText: "Too Many Requests"
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({ kind: "add", reason: "distinct" })
            }
          }
        ]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }));
    const port = createReconciliationLlmDecisionPort({
      config: baseConfig,
      cacheRoot
    });

    const result = await port!.decide({
      incomingContent: "works in Munich",
      candidates: [{ objectId: "memory-a", content: "The user lives in Berlin" }]
    });

    expect(result).toMatchObject({ kind: "add", reason: "distinct" });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("does not retry deterministic 200 response-shape failures", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: ""
            }
          }
        ]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }));
    const port = createReconciliationLlmDecisionPort({
      config: baseConfig,
      cacheRoot
    });

    await expect(port!.decide({
      incomingContent: "works in Munich",
      candidates: [{ objectId: "memory-a", content: "The user lives in Berlin" }]
    })).rejects.toThrow("garden reconciliation decision returned no content");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("fails visible when the model returns malformed decision JSON", async () => {
    const llmComplete = vi.fn(async () => "{not-json");
    const port = createReconciliationLlmDecisionPort({
      config: baseConfig,
      cacheRoot,
      llmComplete
    });

    await expect(port!.decide({
      incomingContent: "works in Munich",
      candidates: [{ objectId: "memory-a", content: "The user lives in Berlin" }]
    })).rejects.toThrow("garden reconciliation decision response was not valid JSON");
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

  it("warns ALAYA_RECONCILIATION_CACHE_READ_FAILED and re-requests when the cache file is corrupt", async () => {
    const llmComplete = vi.fn(async () =>
      JSON.stringify({ kind: "add", reason: "distinct" })
    );
    const port = createReconciliationLlmDecisionPort({ config: baseConfig, cacheRoot, llmComplete });
    const candidates = [{ objectId: "memory-a", content: "The user lives in Berlin" }];

    // Populate the cache, then corrupt the exact file the port wrote.
    await port!.decide({ incomingContent: "works in Munich", candidates });
    const cacheFiles = await findCacheFiles(cacheRoot);
    expect(cacheFiles).toHaveLength(1);
    writeFileSync(cacheFiles[0]!, "{ corrupt", "utf8");

    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    await port!.decide({ incomingContent: "works in Munich", candidates });

    expect(emitWarning).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ code: "ALAYA_RECONCILIATION_CACHE_READ_FAILED" })
    );
    // corrupt read → cache miss → the LLM was called a second time
    expect(llmComplete).toHaveBeenCalledTimes(2);
  });
});

async function findCacheFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  for (const shard of await readdir(root)) {
    const shardPath = join(root, shard);
    for (const file of await readdir(shardPath)) {
      if (file.endsWith(".json")) {
        found.push(join(shardPath, file));
      }
    }
  }
  return found;
}
