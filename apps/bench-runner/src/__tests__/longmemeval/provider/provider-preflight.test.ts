import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeCachedExtraction } from "../../../bench/compile-seed/cache/cache-shard.js";
import {
  findProviderBinding,
  requireProviderBinding,
  resolveVendorModel
} from "../../../bench/provider/catalog.js";
import { probeProviderProtocol } from "../../../bench/provider/protocol-probe.js";
import { proveProviderZeroCallReplay } from "../../../bench/provider/replay-proof.js";
import { retireObsoleteCache } from "../../../bench/provider/retire-obsolete-cache.js";
import { assertRequiredRequestProfile } from "../../../bench/extraction/transport-route.js";
import { digest, loopRequest } from "../diagnostic-loop/fixture.js";
import {
  readExtractionCacheManifestIdentity,
  writeExtractionCacheManifest
} from "../../../bench/extraction/cache/extraction-cache-manifest.js";
import {
  computeExtractionContentClosureSha256,
  computeExtractionKeySetSha256,
  inspectExtractionRawJson
} from
  "../../../bench/extraction/content-closure.js";
import {
  readReplayRequestManifest,
  verifyCanonicalReplayRequestManifest
} from
  "../../../cli/provider-preflight/replay-request-manifest.js";
import { runProviderPreflightCommand } from
  "../../../cli/provider-preflight/command.js";
import {
  canonicalReplayContractDigests,
  rebuildCanonicalReplayKeys
} from
  "../../../cli/provider-preflight/canonical-replay-contract.js";
import { manifestFor } from
  "../extraction/extraction-cache-preflight-fixture.js";
import {
  buildRunnerQuestions,
  createRunnerFixture
} from "../runner-integration/fixture.js";

const MIMO = requireProviderBinding("mimo-v2.5");
const PRIOR_SEMANTIC_PRODUCER_OPERATOR_DIGEST =
  "53de85d652e15c979b74d64c2e1a019fc2451af3277b841a7a3232a6057c7ae5";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("provider catalog", () => {
  it("remaps vendor aliases through the binding table", () => {
    expect(resolveVendorModel("Mimo-V2.5")).toBe(MIMO.id);
    expect(resolveVendorModel("mimo-v2-flash")).toBe(MIMO.id);
    expect(findProviderBinding("unknown-model")).toBeUndefined();
  });

  it("refuses a bound vendor with the wrong request profile", () => {
    expect(() => assertRequiredRequestProfile({
      model: "Mimo-V2.5",
      requestProfile: "provider-default-v1"
    })).toThrow(/requires request profile mimo-v2.5-nonthinking-v1/u);
    expect(() => assertRequiredRequestProfile({
      model: MIMO.id,
      requestProfile: MIMO.requestProfile
    })).not.toThrow();
  });
});

describe("provider protocol probe", () => {
  it("caps physical calls and confirms the sealed F3 identity", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }), { status: 200 }));

    const receipt = await probeProviderProtocol({
      providerUrl: "https://proxy.example/v1",
      apiKey: "sk-test",
      model: MIMO.id,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(receipt.physical_calls).toBe(1);
    expect(receipt.physical_calls).toBeLessThanOrEqual(MIMO.probeCallCeiling);
    expect(receipt.profile).toBe(MIMO.requestProfile);
    expect(receipt.model).toBe(MIMO.id);
    expect(receipt.usage_present).toBe(true);
    expect(receipt.f3_seal_current).toBe(true);
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body.model).toBe(MIMO.id);
    expect(body.enable_thinking).toBe(false);
    expect(body.stream).toBeUndefined();
  });

  it("requests SSE framing for the stream probe", async () => {
    const fetchImpl = vi.fn(async () => new Response(
      "data: {\"choices\":[{\"delta\":{\"content\":\"{\\\"ok\\\":true}\" }}]}\n\n" +
      "data: {\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1,\"total_tokens\":2}}\n\n" +
      "data: [DONE]\n",
      { status: 200, headers: { "content-type": "text/event-stream" } }
    ));
    const receipt = await probeProviderProtocol({
      providerUrl: "https://proxy.example/v1",
      apiKey: "sk-test",
      model: MIMO.id,
      framing: "sse",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(receipt.framing).toBe("sse");
    expect(receipt.physical_calls).toBe(1);
    expect(receipt.json_object).toBe(true);
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body.stream).toBe(true);
    expect(body.model).toBe(MIMO.id);
  });

  it("refuses an empty key", async () => {
    await expect(probeProviderProtocol({
      providerUrl: "https://proxy.example/v1",
      apiKey: "",
      model: MIMO.id,
      fetchImpl: fetch
    })).rejects.toThrow(/empty API key/u);
  });
});

describe("provider cache-only replay", () => {
  it("accepts the current contract and rejects an honestly resealed prior contract", async () => {
    const body = await canonicalReplayManifestBody();
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

    const proof = proveProviderZeroCallReplay({
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

  it("rejects obsolete cache authority", () => {
    expect(() => proveProviderZeroCallReplay({
      request: loopRequest({
        model: MIMO.id,
        requestProfile: "deepseek-v4-nonthinking-v1"
      })
    })).toThrow(/obsolete request profile/u);
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
    expect(proveProviderZeroCallReplay({ request: loaded }).physical_calls).toBe(0);

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

describe("obsolete cache retirement preflight", () => {
  it("fails closed without confirm, path match, or an active lock", async () => {
    const root = await tempRoot();
    expect(() => retireObsoleteCache({
      cacheRoot: root,
      expectedPath: root,
      profile: "deepseek-v4-nonthinking-v1",
      confirm: false
    })).toThrow(/confirm/u);

    expect(() => retireObsoleteCache({
      cacheRoot: root,
      expectedPath: join(root, "other"),
      profile: "deepseek-v4-nonthinking-v1",
      confirm: true
    })).toThrow(/does not match/u);

    mkdirSync(join(root, ".extraction-fill.lock"));
    expect(() => retireObsoleteCache({
      cacheRoot: root,
      expectedPath: root,
      profile: "deepseek-v4-nonthinking-v1",
      confirm: true
    })).toThrow(/in-progress/u);
  });

  it("does not delete after a clean preflight", async () => {
    const root = await tempRoot();
    writeFileSync(join(root, "keep.txt"), "stay");
    const result = retireObsoleteCache({
      cacheRoot: root,
      expectedPath: root,
      profile: "deepseek-v4-nonthinking-v1",
      confirm: true
    });
    expect(result.retired).toBe(false);
  });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "provider-preflight-"));
  roots.push(root);
  return root;
}

function writeCompleteMimoCache(
  cacheRoot: string,
  key: string
): { readonly systemPromptSha256: string } {
  return writeCompleteMimoCacheKeys(cacheRoot, [key], digest("dataset"));
}

function writeCompleteMimoCacheKeys(
  cacheRoot: string,
  keys: readonly string[],
  datasetRevision: string
): { readonly systemPromptSha256: string } {
  const rawJson = "{\"signals\":[]}";
  const inspected = inspectExtractionRawJson(rawJson);
  for (const key of keys) {
    writeCachedExtraction(cacheRoot, key, {
      model: MIMO.id,
      request_profile: MIMO.requestProfile,
      cache_key: key,
      raw_json: rawJson,
      extracted_at: "2026-08-17T00:00:00.000Z"
    });
  }
  const entries = keys.map((key) => ({
    cacheKey: key,
    model: MIMO.id,
    requestProfile: MIMO.requestProfile,
    ...inspected
  }));
  const manifest = manifestFor({
    extraction_model: MIMO.id,
    model_family: MIMO.id,
    request_profile: MIMO.requestProfile,
    provider_url: "mimo",
    dataset_revision: datasetRevision,
    requested_turns: keys.length,
    cached_turns: keys.length,
    coverage: 1,
    fill_status: "complete",
    window_offset: 0,
    window_limit: 1,
    expected_turns: keys.length,
    expected_key_set_sha256: computeExtractionKeySetSha256(keys),
    content_closure_sha256: computeExtractionContentClosureSha256(entries),
    content_closure_index: Object.fromEntries(keys.map((key) => [key, [
        inspected.rawJsonSha256,
        inspected.rawSignalCount,
        inspected.parsedDraftCount
      ]]))
  });
  writeExtractionCacheManifest(cacheRoot, manifest);
  return { systemPromptSha256: manifest.system_prompt_sha256 };
}

async function canonicalReplayManifestBody() {
  const root = await tempRoot();
  const fixture = await createRunnerFixture({
    root,
    label: "canonical-replay",
    variant: "longmemeval_s",
    questions: buildRunnerQuestions("canonical-replay", 1)
  });
  const contract = canonicalReplayContractDigests();
  const requestWithoutKeys = loopRequest({
    datasetRevision: fixture.datasetSha256,
    requestedKeys: [],
    schemaDigest: contract.schemaDigest,
    operatorDigest: contract.operatorDigest,
    extractionCacheRoot: fixture.extractionCacheRoot,
    variant: fixture.variant,
    limit: 1,
    offset: 0
  });
  const keys = await rebuildCanonicalReplayKeys({
    request: requestWithoutKeys,
    dataDir: fixture.dataDir,
    pinnedMetaRoot: fixture.pinnedMetaRoot
  });
  const authority = writeCompleteMimoCacheKeys(
    fixture.extractionCacheRoot,
    keys,
    fixture.datasetSha256
  );
  const request = {
    ...requestWithoutKeys,
    requestedKeys: keys,
    promptDigest: authority.systemPromptSha256
  };
  return replayManifestBody(fixture.extractionCacheRoot, request, {
    data_dir: fixture.dataDir,
    pinned_meta_root: fixture.pinnedMetaRoot
  });
}

function replayManifestBody(
  cacheRoot: string,
  request: ReturnType<typeof loopRequest>,
  datasetAuthority: Readonly<{ readonly data_dir?: string; readonly pinned_meta_root?: string }>
) {
  const cacheIdentity = readExtractionCacheManifestIdentity(cacheRoot)!;
  return {
    schema_version: 1 as const,
    kind: "provider_preflight_replay_request" as const,
    request,
    canonical_keys: {
      count: request.requestedKeys.length,
      key_set_sha256: computeExtractionKeySetSha256(request.requestedKeys)
    },
    cache_authority: {
      manifest_sha256: cacheIdentity.manifestSha256,
      content_closure_sha256: cacheIdentity.manifest.content_closure_sha256,
      expected_key_set_sha256: cacheIdentity.manifest.expected_key_set_sha256,
      shard_count: cacheIdentity.manifest.expected_turns,
      window_offset: cacheIdentity.manifest.window_offset,
      window_limit: cacheIdentity.manifest.window_limit
    },
    dataset_authority: datasetAuthority
  };
}

function sealReplayManifest<T extends Record<string, unknown>>(
  body: T
): T & { readonly request_manifest_sha256: string } {
  return {
    ...body,
    request_manifest_sha256: createHash("sha256")
      .update(JSON.stringify(body), "utf8")
      .digest("hex")
  };
}
