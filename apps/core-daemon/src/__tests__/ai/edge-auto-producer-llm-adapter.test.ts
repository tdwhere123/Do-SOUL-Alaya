import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeRequestKey,
  createEdgeAutoProducerLlmPort,
  type PairInput
} from "../../ai/edge-auto-producer-llm-adapter.js";

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
});
