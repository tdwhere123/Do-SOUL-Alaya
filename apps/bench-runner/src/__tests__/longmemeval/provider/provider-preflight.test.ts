import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sourceBoundF3Seal } from "@do-soul/alaya-soul";
import { writeCachedExtraction } from "../../../bench/compile-seed/cache/cache-shard.js";
import { requireProviderBinding } from "../../../bench/provider/catalog.js";
import { proveProviderZeroCallReplay } from "../../../bench/provider/replay-proof.js";
import {
  ProviderPreflightReplayReceiptSchema,
  verifyProviderPreflightReplayReceipt,
  verifyProviderPreflightReplayReceiptBinding
} from
  "../../../bench/provider/replay-receipt.js";
import { retireObsoleteCache } from "../../../bench/provider/retire-obsolete-cache.js";
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
  "a04ec267912e54669d3c39382d5118da5e6b9d9f3382ab7721179fb0a79f503a";
const roots: string[] = [];

function replayReceiptFixture() {
  return {
    schema_version: 2 as const,
    kind: "provider_preflight_replay_receipt" as const,
    provider_port: "absent" as const,
    physical_calls: 0 as const,
    model: MIMO.id,
    profile: MIMO.requestProfile,
    key_count: 1,
    request_manifest_sha256: "a".repeat(64),
    cache_manifest_sha256: "b".repeat(64),
    evidence_prompt_sha256: "c".repeat(64),
    query_prompt_sha256: "d".repeat(64),
    evidence_request_template_sha256: "e".repeat(64),
    query_request_template_sha256: "f".repeat(64)
  };
}

function receiptForManifest(manifest: ReturnType<typeof sealReplayManifest>) {
  const seal = sourceBoundF3Seal();
  return {
    schema_version: 2 as const,
    kind: "provider_preflight_replay_receipt" as const,
    provider_port: "absent" as const,
    physical_calls: 0 as const,
    model: manifest.request.model,
    profile: manifest.request.requestProfile,
    key_count: manifest.request.requestedKeys.length,
    request_manifest_sha256: manifest.request_manifest_sha256,
    cache_manifest_sha256: manifest.cache_authority.manifest_sha256,
    evidence_prompt_sha256: seal.evidence_prompt_sha256,
    query_prompt_sha256: seal.query_prompt_sha256,
    evidence_request_template_sha256: seal.evidence_request_template_sha256,
    query_request_template_sha256: seal.query_request_template_sha256
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("provider replay receipt", () => {
  it("rejects legacy, minimal, and extra-key evidence shapes", () => {
    const current = replayReceiptFixture();
    expect(ProviderPreflightReplayReceiptSchema.parse(current)).toEqual(current);
    expect(ProviderPreflightReplayReceiptSchema.safeParse({
      ...current,
      schema_version: 1
    }).success).toBe(false);
    expect(ProviderPreflightReplayReceiptSchema.safeParse({
      schema_version: 2,
      kind: "provider_preflight_replay_receipt",
      provider_port: "absent",
      physical_calls: 0
    }).success).toBe(false);
    expect(ProviderPreflightReplayReceiptSchema.safeParse({
      ...current,
      unsealed_note: "accepted by a loose consumer"
    }).success).toBe(false);
    expect(() => verifyProviderPreflightReplayReceipt({
      ...current,
      evidence_request_template_sha256:
        "38fa28af7f5d2a1895cc6cd6879ba3de827800c2713af054f976d3175a348200"
    })).toThrow("semantic contract does not match");
  });

  it.each([
    ["model", { model: "other-model" }],
    ["profile", { profile: "provider-default-v1" }],
    ["key count", { key_count: 999 }],
    ["request digest", { request_manifest_sha256: "1".repeat(64) }],
    ["cache digest", { cache_manifest_sha256: "2".repeat(64) }]
  ])("rejects same-shape %s drift from its canonical authority", async (_label, drift) => {
    const body = await canonicalReplayManifestBody();
    const manifest = sealReplayManifest(body);
    const receipt = receiptForManifest(manifest);
    const cacheRoot = body.request.extractionCacheRoot!;
    const manifestPath = join(cacheRoot, "receipt-request.json");
    const receiptPath = join(cacheRoot, "receipt.json");
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`);

    expect(() => verifyProviderPreflightReplayReceiptBinding(receipt, manifest))
      .not.toThrow();
    await expect(runProviderPreflightCommand([
      "--mode", "validate-replay-receipt",
      "--receipt", receiptPath,
      "--request-manifest", manifestPath
    ])).resolves.toBe(0);
    expect(() => verifyProviderPreflightReplayReceiptBinding({
      ...receipt,
      ...drift
    }, manifest)).toThrow("does not match its canonical request authority");
    await writeFile(receiptPath, `${JSON.stringify({ ...receipt, ...drift })}\n`);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await expect(runProviderPreflightCommand([
      "--mode", "validate-replay-receipt",
      "--receipt", receiptPath,
      "--request-manifest", manifestPath
    ])).resolves.toBe(2);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining(
      "does not match its canonical request authority"
    ));
    stderr.mockRestore();
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
