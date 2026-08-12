import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import { afterEach, describe, expect, it, vi } from "vitest";

import { cacheFilePath } from
  "../../../../longmemeval/compile-seed/compile-seed-cache.js";
import {
  computeSystemPromptSha256, readExtractionCacheManifest
} from "../../../../longmemeval/extraction/cache/extraction-cache-manifest.js";
import {
  createSupplementalSourceReceipt, supplementalSourceManifestBinding
} from "../../../../longmemeval/extraction/cache/supplemental-source-receipt.js";
import { buildExtractionTransportProvenance } from
  "../../../../longmemeval/extraction/transport-route.js";
import { catalogRefillCompletionPath } from
  "../../../../longmemeval/extraction/authority/catalog-refill/completion-witness.js";
import { verifyCommittedAuditedExtractionCacheSuccessor } from
  "../../../../longmemeval/extraction/cache-audit/target-materializer.js";
import {
  createCatalogRefillSuccessorFixture, model, profile, providerUrl,
  type CatalogRefillSuccessorFixture
} from "./catalog-refill-successor-fixture.js";

const physicalProviderUrl = "https://router.huggingface.co/v1";
const physicalModel = "deepseek-ai/DeepSeek-V3.2";
let fixture: CatalogRefillSuccessorFixture | undefined;

afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("catalog-refill supplemental transport provenance binding", () => {
  it("binds one exact alternate route over the catalog remainder", async () => {
    fixture = await createCatalogRefillSuccessorFixture({
      alternateTransport: { providerUrl: physicalProviderUrl, model: physicalModel }
    });
    const manifest = readExtractionCacheManifest(fixture.targetRoot)!;
    const witness = readWitness(fixture);
    const shards = fixture.remainingKeys.map((key) => {
      const cached = readShard(fixture!, key);
      expect(cached.transport_provenance).toEqual(buildExtractionTransportProvenance({
        providerUrl,
        model,
        transportProviderUrl: physicalProviderUrl,
        transportModel: physicalModel
      }));
      expect(cached.model).toBe(model);
      return { cache_key: key, raw_json_sha256: digest(cached.raw_json) };
    });
    const supplemental = createSupplementalSourceReceipt({
      createdAt: String(witness.completed_at),
      physicalProviderUrl,
      physicalModel,
      logicalProviderUrl: providerUrl,
      logicalModel: model,
      requestProfile: profile,
      systemPromptSha256: computeSystemPromptSha256(OFFICIAL_API_SYSTEM_PROMPT),
      shards
    });

    expect(witness).toMatchObject({
      schema_version: 4,
      supplemental_source_receipt: supplemental
    });
    expect(manifest).toMatchObject({
      extraction_model: model,
      provider_url: providerUrl,
      supplemental_source_receipt: supplementalSourceManifestBinding(supplemental)
    });
    expect(() => verifyCommittedAuditedExtractionCacheSuccessor({
      targetRoot: fixture!.targetRoot
    })).not.toThrow();
  }, 15_000);

  it("keeps the direct logical route on the typed witness without a supplemental binding", async () => {
    fixture = await createCatalogRefillSuccessorFixture();

    expect(readWitness(fixture)).toMatchObject({ schema_version: 3 });
    expect(readWitness(fixture)).not.toHaveProperty("supplemental_source_receipt");
    expect(readExtractionCacheManifest(fixture.targetRoot))
      .not.toHaveProperty("supplemental_source_receipt");
  }, 15_000);
});

describe("catalog-refill supplemental transport provenance rejection", () => {
  it.each([
    ["missing physical provider", { model: physicalModel }],
    ["missing physical model", { providerUrl: physicalProviderUrl }],
    ["credentialed physical provider", {
      providerUrl: "https://user:secret@router.huggingface.co/v1",
      model: physicalModel
    }],
    ["query-bearing physical provider", {
      providerUrl: `${physicalProviderUrl}?token=secret`,
      model: physicalModel
    }],
    ["fragment-bearing physical provider", {
      providerUrl: `${physicalProviderUrl}#secret`,
      model: physicalModel
    }]
  ] as const)("rejects a %s route before provider work", async (_label, alternateTransport) => {
    await expectPreProviderRejection({ alternateTransport });
  }, 15_000);

  it.each([
    ["direct logical archive", undefined],
    ["physical alias archive", {
      providerUrl: physicalProviderUrl, model: physicalModel
    }]
  ] as const)("rejects %s storage before provider work", async (_label, alternateTransport) => {
    await expectPreProviderRejection({
      ...(alternateTransport === undefined ? {} : { alternateTransport }),
      mutateInitialTarget: (targetRoot) => mutateManifest(targetRoot, (manifest) => {
        manifest.storage = "archive";
        manifest.archive_url = "https://archive.example/cache.tar.zst";
        manifest.archive_sha256 = "a".repeat(64);
      })
    });
  }, 15_000);

  it("rejects a prior supplemental binding before physical alias provider work", async () => {
    await expectPreProviderRejection({
      alternateTransport: { providerUrl: physicalProviderUrl, model: physicalModel },
      mutateInitialTarget: (targetRoot) => mutateManifest(targetRoot, (manifest) => {
        manifest.supplemental_source_receipt = supplementalSourceManifestBinding(
          createSupplementalSourceReceipt({
            createdAt: "2026-08-12T00:00:00.000Z",
            physicalProviderUrl,
            physicalModel,
            logicalProviderUrl: providerUrl,
            logicalModel: model,
            requestProfile: profile,
            systemPromptSha256: computeSystemPromptSha256(OFFICIAL_API_SYSTEM_PROMPT),
            shards: [{ cache_key: "a".repeat(64), raw_json_sha256: "b".repeat(64) }]
          })
        );
      })
    });
  }, 15_000);
});

async function expectPreProviderRejection(
  options: Parameters<typeof createCatalogRefillSuccessorFixture>[0]
): Promise<void> {
  let providerCalls = 0;
  let resolved: CatalogRefillSuccessorFixture | undefined;
  let rejection: unknown;
  try {
    resolved = await createCatalogRefillSuccessorFixture({
      ...options,
      onExtract: () => { providerCalls += 1; }
    });
  } catch (cause) {
    rejection = cause;
  } finally {
    resolved?.cleanup();
  }
  expect(providerCalls).toBe(0);
  expect(String(rejection)).toMatch(/transport|physical|credential|supplemental|archive/iu);
}

function readWitness(value: CatalogRefillSuccessorFixture): Record<string, unknown> {
  return JSON.parse(readFileSync(catalogRefillCompletionPath(
    value.targetRoot, value.authorityReceipt.receipt_digest
  ), "utf8")) as Record<string, unknown>;
}

function readShard(value: CatalogRefillSuccessorFixture, key: string): {
  readonly model: string;
  readonly raw_json: string;
  readonly transport_provenance?: unknown;
} {
  return JSON.parse(readFileSync(cacheFilePath(value.targetRoot, key), "utf8")) as {
    readonly model: string;
    readonly raw_json: string;
    readonly transport_provenance?: unknown;
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function mutateManifest(
  targetRoot: string,
  mutate: (manifest: Record<string, unknown>) => void
): void {
  const path = join(targetRoot, "manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  mutate(manifest);
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}
