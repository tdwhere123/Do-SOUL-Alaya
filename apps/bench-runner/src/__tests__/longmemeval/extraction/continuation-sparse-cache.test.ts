import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OFFICIAL_API_SYSTEM_PROMPT,
  buildOfficialApiExtractionRequests,
  stringifyOfficialApiExtractionRequest
} from "@do-soul/alaya-soul";
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
  requestProfile: "provider-default-v1" as const
};

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("continuation sparse cache execution", () => {
  it("does not read or delegate a sibling shard outside the missing-key scope", async () => {
    const cacheRoot = temporaryRoot();
    const requests = buildOfficialApiExtractionRequests(
      Array.from({ length: 9 }, (_, index) =>
        `I recorded durable detail number ${index + 1}.`
      ).join(" "),
      []
    );
    expect(requests).toHaveLength(2);
    const keys = requests.map((request) => computeCacheKey(
      config.model,
      config.requestProfile,
      OFFICIAL_API_SYSTEM_PROMPT,
      stringifyOfficialApiExtractionRequest(request)
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
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
      userPrompt: stringifyOfficialApiExtractionRequest(requests[0]!)
    })).resolves.toEqual({ rawJson: '{"signals":[]}' });
    expect(delegate).not.toHaveBeenCalled();

    await expect(extractor.extract({
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
      userPrompt: stringifyOfficialApiExtractionRequest(requests[1]!)
    })).rejects.toThrow(/cache-only.*missing/u);
  });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "alaya-continuation-sparse-cache-"));
  roots.push(root);
  return root;
}
