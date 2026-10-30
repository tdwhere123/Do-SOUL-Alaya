import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SOURCE_STATEMENTS_PROMPT } from "@do-soul/alaya-soul";
import { sourceStatementRequests } from "../../../runs/extraction/source-statement-request.js";
import {
  computeCacheKey,
  createCachingSignalExtractor
} from "../../../runs/compile-seed/compile-seed-cache.js";
import type { BenchSignalExtractor } from
  "../../../runs/compile-seed/compile-seed-types.js";

const roots: string[] = [];
const config = {
  model: "gpt-5.4-mini",
  modelFamily: "gpt-5.4-mini" as const,
  providerUrl: "https://provider.invalid/v1",
  requestProfile: "provider-default-v1" as const,
  sourcePacking: "session-statements" as const
};

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("continuation sparse cache execution", () => {
  it("does not read or delegate a sibling shard outside the missing-key scope", async () => {
    const cacheRoot = temporaryRoot();
    const requests = sourceStatementRequests([
      { message_id: "first", role: "user", content: "a".repeat(15_000) },
      { message_id: "second", role: "user", content: "b".repeat(20_000) }
    ]);
    expect(requests).toHaveLength(2);
    const keys = requests.map((request) => computeCacheKey(
      config.model,
      config.requestProfile,
      SOURCE_STATEMENTS_PROMPT,
      request.userPrompt
    ));
    const delegate = vi.fn<BenchSignalExtractor["extract"]>();
    const extractor = createCachingSignalExtractor({
      delegate: { extract: delegate },
      config,
      cacheRoot,
      allowLiveExtraction: false,
      executionCacheKeys: new Set([keys[1]!])
    });

    await expect(extractor.extract({
      systemPrompt: SOURCE_STATEMENTS_PROMPT,
      userPrompt: requests[0]!.userPrompt
    })).resolves.toEqual({
      rawJson: '{"extraction_skip":"plan_skipped"}',
      extractionSkip: "plan_skipped"
    });
    expect(delegate).not.toHaveBeenCalled();

    await expect(extractor.extract({
      systemPrompt: SOURCE_STATEMENTS_PROMPT,
      userPrompt: requests[1]!.userPrompt
    })).rejects.toThrow(/cache-only.*missing/u);
  });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "alaya-continuation-sparse-cache-"));
  roots.push(root);
  return root;
}
