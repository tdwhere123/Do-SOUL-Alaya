// @ts-nocheck
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { proveProviderZeroCallReplay } from "../../../../bench/provider/replay-proof.js";
import {
  digest,
  loopRequest,
  writeDiagnosticSnapshotFixture,
  writeQueryFactorCacheFixture
} from "../../diagnostic-loop/fixture.js";
import {
  readExtractionCacheManifestIdentity,
  writeExtractionCacheManifest
} from "../../../../bench/extraction/cache/extraction-cache-manifest.js";
import { computeExtractionKeySetSha256 } from
  "../../../../bench/extraction/content-closure.js";
import {
  readReplayRequestManifest,
  verifyCanonicalReplayRequestManifest
} from
  "../../../../cli/provider-preflight/replay-request-manifest.js";
import { runProviderPreflightCommand } from
  "../../../../cli/provider-preflight/command.js";
import { manifestFor } from
  "../../extraction/extraction-cache-preflight-fixture.js";
import {
  MIMO,
  createCanonicalReplayManifestBody,
  replayManifestBody,
  sealReplayManifest,
  writeCompleteMimoCache
} from "./complete-mimo-cache.js";

const PRIOR_SEMANTIC_PRODUCER_OPERATOR_DIGEST =
  "a04ec267912e54669d3c39382d5118da5e6b9d9f3382ab7721179fb0a79f503a";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("provider cache-only replay", () => {
  it("accepts the current contract and rejects an honestly resealed prior contract", async () => {
    const body = await createCanonicalReplayManifestBody((root) => {
      roots.push(root);
    });
    const currentPath = join(body.request.extractionCacheRoot, "current-request.json");
    await writeFile(currentPath, `${JSON.stringify(sealReplayManifest(body))}\n`);

    await expect(verifyCanonicalReplayRequestManifest(currentPath))
      .resolves.toMatchObject({ request: body.request });

    const legacyPath = join(body.request.extractionCacheRoot, "legacy-request.json");
    const legacyBody = {
      ...body,
      request: {
        ...body.request,
        operatorDigest: PRIOR_SEMANTIC_PRODUCER_OPERATOR_DIGEST
      }
    };
    await writeFile(legacyPath, `${JSON.stringify(sealReplayManifest(legacyBody))}\n`);

    await expect(verifyCanonicalReplayRequestManifest(legacyPath))
      .rejects.toThrow("replay request manifest sealed contract digest mismatch");
  });

  it("rejects the legacy scalar replay route without a canonical manifest", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const exitCode = await runProviderPreflightCommand([
      "--mode", "replay",
      "--model", MIMO.id,
      "--request-profile", MIMO.requestProfile,
      "--requested-keys", digest("legacy-key")
    ]);

    expect(exitCode).toBe(2);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("--request-manifest is required"));
  });

  it("proves zero physical calls on a bound-profile cache", async () => {
    const cacheRoot = await tempRoot();
    const key = digest("provider-key");
    const authority = writeCompleteMimoCache(cacheRoot, key);

    const proof = await proveProviderZeroCallReplay({
      request: loopRequest({
        extractionCacheRoot: cacheRoot,
        requestedKeys: [key],
        model: MIMO.id,
        requestProfile: MIMO.requestProfile,
        promptDigest: authority.systemPromptSha256
      })
    });
    expect(proof.physical_calls).toBe(0);
  });

  it("fail-closes a bound query cache that is missing or profile-drifted", async () => {
    const cacheRoot = await tempRoot();
    const key = digest("query-cache-key");
    const authority = writeCompleteMimoCache(cacheRoot, key);
    const request = loopRequest({
      extractionCacheRoot: cacheRoot,
      requestedKeys: [key],
      model: MIMO.id,
      requestProfile: MIMO.requestProfile,
      promptDigest: authority.systemPromptSha256,
      treatmentFactorCachePath: join(cacheRoot, "missing-query-cache.json")
    });
    await expect(proveProviderZeroCallReplay({ request }))
      .rejects.toThrow(/request source set|missing or unreadable/u);

    const queryPath = join(cacheRoot, "query-cache.json");
    await writeQueryFactorCacheFixture(queryPath, "Question A?");
    await expect(proveProviderZeroCallReplay({
      request: { ...request, treatmentFactorCachePath: queryPath }
    })).rejects.toThrow(/request source set|snapshot/u);

    const snapshot = await writeDiagnosticSnapshotFixture(cacheRoot, "replay-bind");
    await rm(queryPath);
    await writeQueryFactorCacheFixture(queryPath, "Question q-1?");
    const bound = { ...request, snapshotPath: snapshot, treatmentFactorCachePath: queryPath };
    expect((await proveProviderZeroCallReplay({ request: bound })).physical_calls).toBe(0);

    await writeFile(queryPath, JSON.stringify({
      ...JSON.parse(readFileSync(queryPath, "utf8")),
      request_profile: "provider-default-v1"
    }));
    await expect(proveProviderZeroCallReplay({ request: bound }))
      .rejects.toThrow(/content digest mismatch|request profile|cannot bind/u);

    await rm(queryPath);
    await writeQueryFactorCacheFixture(queryPath, "Question q-1?");
    await expect(proveProviderZeroCallReplay({
      request: { ...bound, model: "other-model" }
    })).rejects.toThrow(/model/u);
    await expect(proveProviderZeroCallReplay({
      request: { ...bound, providerRoute: "other-route" }
    })).rejects.toThrow(/provider route/u);

    const sealed = JSON.parse(readFileSync(queryPath, "utf8")) as Record<string, unknown>;
    const { cache_content_sha256: _digest, ...body } = sealed;
    body.request_template_sha256 = `sha256:${"a".repeat(64)}`;
    await writeFile(queryPath, JSON.stringify({
      ...body,
      cache_content_sha256: `sha256:${createHash("sha256")
        .update(JSON.stringify(body)).digest("hex")}`
    }));
    await expect(proveProviderZeroCallReplay({ request: bound }))
      .rejects.toThrow(/cannot bind|prompt_or_request_template|request template|content digest/u);

    await rm(queryPath);
    await writeQueryFactorCacheFixture(queryPath, "Question A?");
    await expect(proveProviderZeroCallReplay({ request: bound }))
      .rejects.toThrow(/missing a required query source|source set does not match/u);
  });

  it("rejects obsolete cache authority", async () => {
    await expect(proveProviderZeroCallReplay({
      request: loopRequest({
        model: MIMO.id,
        requestProfile: "deepseek-v4-nonthinking-v1"
      })
    })).rejects.toThrow(/obsolete request profile/u);
  });

  it("loads a complete canonical request manifest and preserves zero-call proof", async () => {
    const cacheRoot = await tempRoot();
    const key = digest("provider-manifest-key");
    const authority = writeCompleteMimoCache(cacheRoot, key);
    const request = loopRequest({
      extractionCacheRoot: cacheRoot,
      requestedKeys: [key],
      promptDigest: authority.systemPromptSha256,
      limit: 1,
      offset: 0
    });
    const manifestPath = join(cacheRoot, "replay-request.json");
    const body = replayManifestBody(cacheRoot, request, {});
    await writeFile(manifestPath, `${JSON.stringify(sealReplayManifest(body))}\n`);

    const loaded = readReplayRequestManifest(manifestPath);
    expect(loaded).toEqual(request);
    expect((await proveProviderZeroCallReplay({ request: loaded })).physical_calls).toBe(0);

    const extraPath = join(cacheRoot, "replay-request-extra.json");
    await writeFile(extraPath, `${JSON.stringify(sealReplayManifest({
      ...body,
      request: { ...request, extraAuthority: "untrusted" }
    }))}\n`);
    expect(() => readReplayRequestManifest(extraPath)).toThrow(
      /invalid provider replay request manifest/u
    );
  });

  it("rejects a request manifest that labels one key as a larger window", async () => {
    const cacheRoot = await tempRoot();
    writeExtractionCacheManifest(cacheRoot, manifestFor());
    const cacheIdentity = readExtractionCacheManifestIdentity(cacheRoot)!;
    const key = digest("single-key");
    const manifestPath = join(cacheRoot, "bad-replay-request.json");
    await writeFile(manifestPath, `${JSON.stringify(sealReplayManifest({
      schema_version: 1,
      kind: "provider_preflight_replay_request",
      request: loopRequest({
        extractionCacheRoot: cacheRoot, requestedKeys: [key], limit: 1, offset: 0
      }),
      canonical_keys: {
        count: 2,
        key_set_sha256: computeExtractionKeySetSha256([key])
      },
      cache_authority: {
        manifest_sha256: cacheIdentity.manifestSha256,
        content_closure_sha256: digest("content-closure"),
        expected_key_set_sha256: digest("expected-keys"),
        shard_count: 1,
        window_offset: 0,
        window_limit: 1
      },
      dataset_authority: {}
    }))}\n`);
    expect(() => readReplayRequestManifest(manifestPath)).toThrow(/key count mismatch/u);
  });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "provider-preflight-"));
  roots.push(root);
  return root;
}
