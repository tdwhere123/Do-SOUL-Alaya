import { afterEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";

// EXTRACTION_CACHE_ROOT reads the env at module-load, so each case resets modules + re-imports.
describe("EXTRACTION_CACHE_ROOT cache-root override", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("redirects to ALAYA_BENCH_EXTRACTION_CACHE_ROOT (staging) when set", async () => {
    vi.stubEnv("ALAYA_BENCH_EXTRACTION_CACHE_ROOT", "/tmp/alaya-staging-cache");
    vi.resetModules();
    const { EXTRACTION_CACHE_ROOT } = await import("../../longmemeval/compile-seed-config.js");
    expect(EXTRACTION_CACHE_ROOT).toBe(resolve("/tmp/alaya-staging-cache"));
  });

  it("falls back to the canonical git-tracked fixture path when unset", async () => {
    vi.stubEnv("ALAYA_BENCH_EXTRACTION_CACHE_ROOT", undefined as unknown as string);
    vi.resetModules();
    const { EXTRACTION_CACHE_ROOT } = await import("../../longmemeval/compile-seed-config.js");
    expect(EXTRACTION_CACHE_ROOT.endsWith("docs/bench-history/datasets/longmemeval-extraction-cache")).toBe(true);
  });
});
