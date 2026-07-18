import { readdirSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  inspectExtractionAuthority,
  readCurrentExtractionAuthorityRevision
} from "../../../longmemeval/extraction/authority/inspection.js";
import {
  createExtractionAuthorityReceipt,
  writeExtractionAuthorityReceipt
} from "../../../longmemeval/extraction/authority/receipt.js";
import {
  readExtractionCacheManifest,
  writeExtractionCacheManifest
} from "../../../longmemeval/extraction/cache/extraction-cache-manifest.js";
import type { SupplementalSourceManifestBinding } from
  "../../../longmemeval/extraction/cache/supplemental-source-receipt.js";
import { runExtractionFill } from
  "../../../longmemeval/extraction/extraction-fill.js";
import {
  assertSnapshotExtractionAuthorityBinding,
  captureSnapshotExtractionAuthority
} from "../../../longmemeval/snapshot/extraction-authority.js";
import {
  buildExtractionFillQuestion,
  EXTRACTION_FILL_VARIANT,
  registerExtractionFillHooks
} from "./fixture.js";

let cacheRoot: string;
let dataDir: string;
let pinnedMetaRoot: string;
const writeFixtureDataset = registerExtractionFillHooks((roots) => {
  ({ cacheRoot, dataDir, pinnedMetaRoot } = roots);
});

afterEach(() => vi.unstubAllGlobals());

describe("cache-only extraction window reframing", () => {
  it("closes a cached prefix for snapshot and can honestly reopen the wider window", async () => {
    await writeFixtureDataset([
      buildExtractionFillQuestion("q001", "User: alpha", "User: decoy"),
      buildExtractionFillQuestion("q002", "User: beta", "User: distraction")
    ]);
    await seedFirstQuestion();
    attachSupplementalSource();
    await frameFullWindowAsIncomplete();
    const initialShardCount = shardCount();
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const closed = await runExtractionFill({
      variant: EXTRACTION_FILL_VARIANT,
      limit: 1,
      offset: 0,
      cacheRoot,
      dataDir,
      pinnedMetaRoot,
      log: () => undefined
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(closed).toMatchObject({ cacheHits: 2, newlyExtracted: 0 });
    expect(closed.manifest).toMatchObject({
      fill_status: "complete",
      window_offset: 0,
      window_limit: 1,
      expected_turns: 2,
      supplemental_source_receipt: SUPPLEMENTAL_SOURCE
    });
    const snapshot = captureSnapshotExtractionAuthority(cacheRoot);
    expect(snapshot.compact).toMatchObject({ window_limit: 1, expected_turns: 2 });
    expect(() => assertSnapshotExtractionAuthorityBinding(snapshot.authority, {
      ...snapshot.compact,
      window_limit: 2
    })).toThrow(/compact summary differs/u);

    await reopenFullWindowWithFreshAuthority();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readExtractionCacheManifest(cacheRoot)).toMatchObject({
      fill_status: "in_progress",
      window_limit: 2,
      expected_turns: 4,
      supplemental_source_receipt: SUPPLEMENTAL_SOURCE
    });
    expect(() => captureSnapshotExtractionAuthority(cacheRoot))
      .toThrow(/complete.*manifest/u);
    expect(shardCount()).toBe(initialShardCount);
  });
});

async function seedFirstQuestion(): Promise<void> {
  await runExtractionFill({
    variant: EXTRACTION_FILL_VARIANT,
    limit: 1,
    cacheRoot,
    dataDir,
    pinnedMetaRoot,
    extractorFactory: () => ({ extract: async () => ({ rawJson: '{"signals":[]}' }) }),
    log: () => undefined
  });
}

function attachSupplementalSource(): void {
  const manifest = readExtractionCacheManifest(cacheRoot);
  if (manifest === undefined || manifest.schema_version !== 3) {
    throw new Error("expected current extraction manifest");
  }
  writeExtractionCacheManifest(cacheRoot, {
    ...manifest,
    supplemental_source_receipt: SUPPLEMENTAL_SOURCE
  });
}

async function frameFullWindowAsIncomplete(): Promise<void> {
  await runExtractionFill({
    variant: EXTRACTION_FILL_VARIANT,
    cacheRoot,
    dataDir,
    pinnedMetaRoot,
    questionBatchLimit: 1,
    extractorFactory: () => ({ extract: async () => {
      throw new Error("cached question must not call the delegate");
    } }),
    log: () => undefined
  });
}

async function reopenFullWindowWithFreshAuthority(): Promise<void> {
  vi.stubEnv("ALAYA_OFFICIAL_GARDEN_SECRET_REF", "env:CACHE_ONLY_REOPEN_KEY");
  vi.stubEnv("CACHE_ONLY_REOPEN_KEY", "test-key");
  const inspection = await inspectExtractionAuthority({
    variant: EXTRACTION_FILL_VARIANT,
    cacheRoot,
    dataDir,
    pinnedMetaRoot,
    revision: readCurrentExtractionAuthorityRevision(),
    action: "fill"
  });
  const receipt = createExtractionAuthorityReceipt({
    action: "fill",
    observation: inspection.observation,
    outputTokenCap: { field: "max_tokens", value: 512 },
    priceEstimate: {
      inputUsdPerMillion: 0,
      outputUsdPerMillion: 0,
      maximumInputTokensPerAttempt: 300
    },
    diskFloorBytes: 0,
    inspection: {
      writerLock: inspection.writerLock,
      disk: inspection.disk,
      credentialStatus: inspection.credentialStatus,
      modelReadiness: inspection.modelReadiness
    }
  });
  const path = `${cacheRoot}/full-window-authority.json`;
  writeExtractionAuthorityReceipt(path, receipt);
  await runExtractionFill({
    variant: EXTRACTION_FILL_VARIANT,
    cacheRoot,
    dataDir,
    pinnedMetaRoot,
    questionBatchLimit: 1,
    authorityReceiptPath: path,
    log: () => undefined
  });
}

function shardCount(): number {
  return readdirSync(cacheRoot).filter((entry) => /^[a-f0-9]{2}$/u.test(entry))
    .reduce((count, prefix) => count + readdirSync(`${cacheRoot}/${prefix}`).length, 0);
}

const SUPPLEMENTAL_SOURCE: SupplementalSourceManifestBinding = {
  kind: "longmemeval-extraction-supplemental-source",
  receipt_sha256: "a".repeat(64),
  shard_count: 1,
  key_set_sha256: "b".repeat(64),
  physical_provider_url: "https://user:secret@supplement.example/v1?key=hidden",
  physical_model: "fixture-model"
};
