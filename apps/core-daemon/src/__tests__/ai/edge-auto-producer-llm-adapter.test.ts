import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeRequestKey,
  createEdgeAutoProducerLlmPort,
  resolveEdgeAutoProducerDecisionCacheRoot,
  type PairInput
} from "../../ai/edge-auto-producer-llm-adapter.js";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async (_host: string, options?: { all?: boolean }) => {
    const answer = { address: "93.184.216.34", family: 4 };
    return options?.all === true ? [answer] : answer;
  })
}));

const baseConfig = {
  providerUrl: "https://example.test/v1",
  model: "test-model",
  apiKey: "sk-test"
} as const;

describe("createEdgeAutoProducerLlmPort", () => {
  let cacheRoot: string;

  beforeEach(() => {
    cacheRoot = mkdtempSync(join(tmpdir(), "edge-llm-cache-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(cacheRoot, { recursive: true, force: true });
  });

  it("retries transient garden HTTP failures before parsing the verdict", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("server unavailable", {
        status: 503,
        statusText: "Service Unavailable"
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                edge_type: "supports",
                confidence: 0.92,
                rationale: "same stated preference"
              })
            }
          }
        ]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }));
    const port = createEdgeAutoProducerLlmPort({
      config: baseConfig,
      cacheRoot
    });

    const result = await port!.classifyPair({
      newMemory: {
        content: "The user prefers tea.",
        domain_tags: ["preference"],
        dimension: "preference",
        scope_class: "project"
      },
      neighbor: {
        content: "The user likes tea.",
        domain_tags: ["preference"],
        dimension: "preference",
        scope_class: "project"
      }
    } as never);

    expect(result).toEqual({
      edgeType: "supports",
      confidence: 0.92,
      rationale: "same stated preference"
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  const newMemory = {
    content: "The user prefers tea.",
    domain_tags: ["preference"],
    dimension: "preference",
    scope_class: "project"
  } as const;
  const neighbor = { content: "The user likes tea.", domain_tags: ["preference"] } as const;

  it("warns ALAYA_EDGE_AUTO_PRODUCER_LLM_FAILED and degrades to null when the LLM transport rejects", async () => {
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const port = createEdgeAutoProducerLlmPort({
      config: baseConfig,
      cacheRoot,
      llmComplete: async () => {
        throw new Error("garden offline");
      }
    });

    const result = await port!.classifyPair({ newMemory, neighbor } as never);

    expect(result).toBeNull();
    expect(emitWarning).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ code: "ALAYA_EDGE_AUTO_PRODUCER_LLM_FAILED" })
    );
  });

  it("warns ALAYA_EDGE_AUTO_PRODUCER_VERDICT_MALFORMED and degrades to none on non-JSON output", async () => {
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const port = createEdgeAutoProducerLlmPort({
      config: baseConfig,
      cacheRoot,
      llmComplete: async () => "not json at all"
    });

    const result = await port!.classifyPair({ newMemory, neighbor } as never);

    expect(result).toBeNull();
    expect(emitWarning).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ code: "ALAYA_EDGE_AUTO_PRODUCER_VERDICT_MALFORMED" })
    );
  });

  it("warns ALAYA_EDGE_AUTO_PRODUCER_CACHE_READ_FAILED when the on-disk cache is corrupt", async () => {
    const pair: PairInput = {
      newContent: newMemory.content,
      newTags: newMemory.domain_tags,
      neighborContent: neighbor.content,
      neighborTags: neighbor.domain_tags,
      dimension: newMemory.dimension,
      scopeClass: newMemory.scope_class
    };
    const requestKey = computeRequestKey(baseConfig.model, pair);
    const cacheDir = join(cacheRoot, requestKey.slice(0, 2));
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, `${requestKey}.json`), "{ corrupt json", "utf8");

    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const llmComplete = vi.fn(async () =>
      JSON.stringify({ edge_type: "none", confidence: 0, rationale: "x" })
    );
    const port = createEdgeAutoProducerLlmPort({ config: baseConfig, cacheRoot, llmComplete });

    await port!.classifyPair({ newMemory, neighbor } as never);

    expect(emitWarning).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ code: "ALAYA_EDGE_AUTO_PRODUCER_CACHE_READ_FAILED" })
    );
    // corrupt cache became a miss → the LLM was called to refill it
    expect(llmComplete).toHaveBeenCalledTimes(1);
  });

  it("does not cache a non-JSON verdict so the next classify still calls the model", async () => {
    const llmComplete = vi.fn(async () => "not json at all");
    const port = createEdgeAutoProducerLlmPort({
      config: baseConfig,
      cacheRoot,
      llmComplete
    });

    await port!.classifyPair({ newMemory, neighbor } as never);
    await port!.classifyPair({ newMemory, neighbor } as never);

    expect(llmComplete).toHaveBeenCalledTimes(2);
    expect(listCachedVerdictFiles(cacheRoot)).toEqual([]);
  });

  it("does not cache a non-object JSON verdict", async () => {
    const llmComplete = vi.fn(async () => JSON.stringify(["supports"]));
    const port = createEdgeAutoProducerLlmPort({
      config: baseConfig,
      cacheRoot,
      llmComplete
    });

    await port!.classifyPair({ newMemory, neighbor } as never);
    await port!.classifyPair({ newMemory, neighbor } as never);

    expect(llmComplete).toHaveBeenCalledTimes(2);
    expect(listCachedVerdictFiles(cacheRoot)).toEqual([]);
  });

  it("caches a well-formed none verdict and reuses it within TTL", async () => {
    const llmComplete = vi.fn(async () =>
      JSON.stringify({ edge_type: "none", confidence: 0.1, rationale: "unrelated" })
    );
    const port = createEdgeAutoProducerLlmPort({
      config: baseConfig,
      cacheRoot,
      llmComplete
    });

    await port!.classifyPair({ newMemory, neighbor } as never);
    const second = await port!.classifyPair({ newMemory, neighbor } as never);

    expect(second).toBeNull();
    expect(llmComplete).toHaveBeenCalledTimes(1);
    expect(listCachedVerdictFiles(cacheRoot)).toHaveLength(1);
  });

  it("treats an expired schema-versioned cache entry as a miss", async () => {
    const pair: PairInput = {
      newContent: newMemory.content,
      newTags: newMemory.domain_tags,
      neighborContent: neighbor.content,
      neighborTags: neighbor.domain_tags,
      dimension: newMemory.dimension,
      scopeClass: newMemory.scope_class
    };
    const requestKey = computeRequestKey(baseConfig.model, pair);
    const cacheDir = join(cacheRoot, requestKey.slice(0, 2));
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(join(cacheDir, `${requestKey}.json`), JSON.stringify({
      schema_version: 1,
      model: baseConfig.model,
      request_hash: requestKey,
      edge_type: "supports",
      confidence: 0.9,
      rationale: "expired",
      decided_at: "2020-01-01T00:00:00.000Z"
    }), "utf8");
    const llmComplete = vi.fn(async () =>
      JSON.stringify({ edge_type: "none", confidence: 0, rationale: "fresh" })
    );
    const port = createEdgeAutoProducerLlmPort({
      config: baseConfig,
      cacheRoot,
      cacheTtlMs: 60_000,
      now: () => Date.parse("2026-09-12T00:00:00.000Z"),
      llmComplete
    });

    const result = await port!.classifyPair({ newMemory, neighbor } as never);

    expect(result).toBeNull();
    expect(llmComplete).toHaveBeenCalledTimes(1);
  });

  it("resolves the default verdict cache under DATA_DIR", () => {
    expect(resolveEdgeAutoProducerDecisionCacheRoot({ DATA_DIR: "/tmp/alaya-data" })).toBe(
      resolve("/tmp/alaya-data", "cache", "edge-auto-producer-decisions")
    );
  });
});

function listCachedVerdictFiles(cacheRoot: string): string[] {
  try {
    return readdirSync(cacheRoot, { recursive: true, encoding: "utf8" })
      .filter((entry) => entry.endsWith(".json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}
