// @ts-nocheck
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CACHED_F3_EXPOSURE_POLICY } from
  "../../../bench/diagnostics/stage-attribution/exposure/contract.js";
import {
  CANARY_Q1,
  CANARY_Q2,
  CANARY_Q3,
  CANARY_QUERY_TEXTS
} from "../../../bench/diagnostics/stage-attribution/exposure/canary-ids.js";
import { assertCanaryQueryWindowCompatibility } from
  "../../../bench/diagnostic-loop/canary-unlock-query-window.js";
import type { ResolvedDiagnosticLoopIdentity } from
  "../../../bench/diagnostic-loop/authority/identity.js";
import { loopRequest, writeQueryFactorCacheEntries } from "./fixture.js";
import {
  QuerySemanticFactorCacheSchema,
  assertQuerySemanticFactorCacheSelfSeal,
  queryCacheStableJson,
  toBinding
} from "../../../bench/query-factors/cache/document.js";
import { queryCachePrefixedSha256 } from
  "../../../bench/query-factors/query-semantic-factor-cache-identity.js";
import { sha256Buffer } from "../../../bench/snapshot/bound-file.js";

const WINDOW = [
  CANARY_QUERY_TEXTS[CANARY_Q1],
  CANARY_QUERY_TEXTS[CANARY_Q2],
  CANARY_QUERY_TEXTS[CANARY_Q3]
] as const;
const EXTRA_QUERY = "What did I buy last Sunday?";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Canary query-window compatibility", () => {
  it("admits a 3Q window that is a subset of a larger 100Q cache", async () => {
    const prior = await windowIdentity("query-3q.json", WINDOW);
    const current = await windowIdentity("query-100q.json", [...WINDOW, EXTRA_QUERY]);
    expect(prior.query_factor_cache?.file_sha256)
      .not.toBe(current.query_factor_cache?.file_sha256);
    expect(prior.query_factor_cache?.source_set_sha256)
      .not.toBe(current.query_factor_cache?.source_set_sha256);
    await expect(assertCanaryQueryWindowCompatibility(prior, current)).resolves.toBeUndefined();
  });

  it("fail-closes a missing cache path, digest, or window entry", async () => {
    const prior = await windowIdentity("query-3q.json", WINDOW);
    const current = await windowIdentity("query-100q.json", [...WINDOW, EXTRA_QUERY]);
    const { query_factor_cache: _missing, ...withoutPath } = prior;
    await expect(assertCanaryQueryWindowCompatibility(withoutPath, current))
      .rejects.toThrow(/missing a bound query cache file/u);

    await expect(assertCanaryQueryWindowCompatibility(prior, {
      ...current,
      query_factor_cache: {
        ...current.query_factor_cache!,
        file_sha256: `sha256:${"0".repeat(64)}`
      }
    })).rejects.toThrow(/file digest does not match identity/u);

    const missingEntry = await windowIdentity("query-missing-q3.json", WINDOW.slice(0, 2));
    await expect(assertCanaryQueryWindowCompatibility(prior, missingEntry))
      .rejects.toThrow(/missing a 3Q window entry/u);
  });

  it("fail-closes a changed overlapping capture or a foreign cache file", async () => {
    const prior = await windowIdentity("query-3q.json", WINDOW);
    const changedPath = join(await currentRoot(), "query-changed.json");
    await writeQueryFactorCacheEntries(changedPath, WINDOW);
    const raw = JSON.parse(await readFile(changedPath, "utf8")) as {
      entries: Array<{ capture: unknown }>;
    } & Record<string, unknown>;
    const { cache_content_sha256: _digest, ...body } = {
      ...raw,
      entries: raw.entries.map((entry, index, all) => index === 0
        ? { ...entry, capture: all[1]!.capture }
        : entry)
    };
    await writeFile(changedPath, `${JSON.stringify({
      ...body,
      cache_content_sha256: queryCachePrefixedSha256(queryCacheStableJson(body))
    })}\n`);
    await expect(assertCanaryQueryWindowCompatibility(prior, await identityFromFile(changedPath)))
      .rejects.toThrow(/query window canary entries do not match/u);

    const foreign = await windowIdentity("query-foreign.json", [EXTRA_QUERY]);
    await expect(assertCanaryQueryWindowCompatibility(prior, foreign))
      .rejects.toThrow(/missing a 3Q window entry|query cache/u);
  });
});

async function windowIdentity(
  name: string,
  sourceTexts: readonly string[]
): Promise<ResolvedDiagnosticLoopIdentity> {
  const path = join(await currentRoot(), name);
  await writeQueryFactorCacheEntries(path, sourceTexts);
  return await identityFromFile(path);
}

async function identityFromFile(path: string): Promise<ResolvedDiagnosticLoopIdentity> {
  const bytes = Buffer.from(await readFile(path));
  const cache = QuerySemanticFactorCacheSchema.parse(JSON.parse(bytes.toString("utf8")));
  assertQuerySemanticFactorCacheSelfSeal(cache);
  return {
    schema_version: 3,
    canonical_mode: "cache_only",
    request_identity_digest: "canary-query-window",
    request: loopRequest(),
    treatment_exposure_policy: CACHED_F3_EXPOSURE_POLICY,
    query_factor_cache: {
      path: resolve(path),
      file_sha256: sha256Buffer(bytes),
      ...toBinding(cache)
    }
  };
}

async function currentRoot(): Promise<string> {
  if (roots[0] !== undefined) return roots[0];
  const root = await mkdtemp(join(tmpdir(), "canary-query-window-"));
  await mkdir(root, { recursive: true });
  roots.push(root);
  return root;
}
