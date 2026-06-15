import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEdgeAutoProducerLlmPort } from "../../ai/edge-auto-producer-llm-adapter.js";

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
});
