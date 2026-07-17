import { existsSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OfficialApiGardenProvider } from "@do-soul/alaya-soul";
import { runLongMemEval } from "../../../longmemeval/runner.js";
import {
  snapshotManifestPath,
  snapshotSidecarPath
} from "../../../longmemeval/snapshot/materialize.js";
import {
  buildLongMemEvalFixtureQuestion,
  writeLongMemEvalFixtureDataset
} from "../longmemeval-fixture.js";
import { removeTempDirectory } from "../../support/temp-cleanup.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "recall-eval-substrate-"));
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", "test-extraction-model");
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", "provider-default-v1");
  vi.stubEnv("ALAYA_BENCH_ALLOW_LIVE_EXTRACTION", "0");
  vi.stubEnv("ALAYA_OFFICIAL_GARDEN_SECRET_REF", "");
  vi.spyOn(OfficialApiGardenProvider.prototype, "compile").mockRejectedValue(
    new Error("snapshot preflight must not call the provider")
  );
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await removeTempDirectory(root);
});

describe("recall-eval snapshot substrate boundary", () => {
  it("refuses a synthetic pinned substrate before API or snapshot artifacts", async () => {
    const dataDir = join(root, "data");
    const pinnedMetaRoot = join(root, "pinned");
    await Promise.all([
      mkdir(dataDir, { recursive: true }),
      mkdir(pinnedMetaRoot, { recursive: true })
    ]);
    await writeLongMemEvalFixtureDataset({
      variant: "longmemeval_oracle",
      dataDir,
      pinnedMetaRoot,
      questions: [buildLongMemEvalFixtureQuestion("q001", "s-001")]
    });
    const snapshotDbPath = join(root, "snapshot.db");

    await expect(runLongMemEval({
      variant: "longmemeval_oracle",
      historyRoot: join(root, "history"),
      dataDir,
      pinnedMetaRoot,
      snapshotOut: snapshotDbPath,
      extractionCacheRoot: join(root, "missing-cache")
    })).rejects.toThrow(/canonical pinned dataset authority/u);

    expect(OfficialApiGardenProvider.prototype.compile).not.toHaveBeenCalled();
    expect(existsSync(snapshotDbPath)).toBe(false);
    expect(existsSync(snapshotManifestPath(snapshotDbPath))).toBe(false);
    expect(existsSync(snapshotSidecarPath(snapshotDbPath))).toBe(false);
  });
});
