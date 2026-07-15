import { afterEach, expect, it, vi } from "vitest";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { pathEndsWithPosixSegments, pathsEqual } from "../support/test-paths.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");

// EXTRACTION_CACHE_ROOT reads the env at module-load, so each case resets modules + re-imports.
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it("redirects to ALAYA_BENCH_EXTRACTION_CACHE_ROOT (staging) when set", async () => {
  const staging = join(tmpdir(), "alaya-staging-cache");
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_CACHE_ROOT", staging);
  vi.resetModules();
  const { EXTRACTION_CACHE_ROOT } = await import("../../longmemeval/compile-seed-config.js");
  expect(pathsEqual(EXTRACTION_CACHE_ROOT, resolve(staging))).toBe(true);
});

it("falls back to the canonical git-tracked fixture path when unset", async () => {
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_CACHE_ROOT", undefined as unknown as string);
  vi.resetModules();
  const { EXTRACTION_CACHE_ROOT } = await import("../../longmemeval/compile-seed-config.js");
  expect(
    pathEndsWithPosixSegments(
      EXTRACTION_CACHE_ROOT,
      "docs",
      "bench-history",
      "datasets",
      "longmemeval-extraction-cache"
    )
  ).toBe(true);
  expect(
    pathsEqual(
      EXTRACTION_CACHE_ROOT,
      resolve(repoRoot, "docs/bench-history/datasets/longmemeval-extraction-cache")
    )
  ).toBe(true);
});

it("resolves an explicit run root ahead of environment and canonical defaults", async () => {
  const explicit = join(tmpdir(), "alaya-explicit-cache");
  const staging = join(tmpdir(), "alaya-staging-cache");
  const { resolveEffectiveExtractionCacheRoot } = await import(
    "../../longmemeval/compile-seed-config.js"
  );

  expect(resolveEffectiveExtractionCacheRoot(explicit, {
    ALAYA_BENCH_EXTRACTION_CACHE_ROOT: staging
  })).toBe(resolve(explicit));
});

it("resolves the environment root at the run boundary when no explicit root exists", async () => {
  const staging = join(tmpdir(), "alaya-late-staging-cache");
  const { resolveEffectiveExtractionCacheRoot } = await import(
    "../../longmemeval/compile-seed-config.js"
  );

  expect(resolveEffectiveExtractionCacheRoot(undefined, {
    ALAYA_BENCH_EXTRACTION_CACHE_ROOT: staging
  })).toBe(resolve(staging));
});
