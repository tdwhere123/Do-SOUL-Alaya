import { mkdir, mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OfficialApiGardenProvider } from "@do-soul/alaya-soul";
import { runCli } from "../../cli/index.js";
import {
  snapshotManifestPath,
  snapshotSidecarPath
} from "../../longmemeval/snapshot/materialize.js";
import {
  buildLongMemEvalFixtureQuestion,
  writeLongMemEvalFixtureDataset
} from "../longmemeval/longmemeval-fixture.js";
import {
  isTransientFsLockError,
  removeTempDirectory
} from "../support/temp-cleanup.js";

// @anchor cli-snapshot-out-e2e — the snapshot producer must be CLI-reachable,
// while synthetic dataset roots remain unable to mint release authority.

const VARIANT = "longmemeval_oracle";

let tmpDir: string;
let dataDir: string;
let pinnedMetaRoot: string;
let stdoutBuf: string;
let stderrBuf: string;
let originalStdoutWrite: typeof process.stdout.write;
let originalStderrWrite: typeof process.stderr.write;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "cli-snapshot-out-"));
  dataDir = join(tmpDir, "data");
  pinnedMetaRoot = join(tmpDir, "pinned");
  await mkdir(dataDir, { recursive: true });
  await mkdir(pinnedMetaRoot, { recursive: true });
  // The hostile provider proves substrate rejection happens before extraction.
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", "test-extraction-model");
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", "provider-default-v1");
  vi.stubEnv("ALAYA_OFFICIAL_GARDEN_SECRET_REF", "");
  vi.stubEnv("ALAYA_HOSTILE_DUMMY_KEY", "must-not-be-used");
  vi.stubEnv("ALAYA_BENCH_ALLOW_LIVE_EXTRACTION", "0");
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", "http://127.0.0.1:1/v1");
  vi.stubEnv("ALAYA_GARDEN_PROVIDER_KIND", "host_worker");
  vi.stubEnv("ALAYA_INGEST_RECONCILIATION_ENABLED", "1");
  vi.stubEnv("ALAYA_CONFLICT_DETECTION_ENABLED", "1");
  vi.spyOn(OfficialApiGardenProvider.prototype, "compile").mockRejectedValue(
    new Error("hostile fixture provider must not run")
  );
  stdoutBuf = "";
  stderrBuf = "";
  originalStdoutWrite = process.stdout.write.bind(process.stdout);
  originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutBuf += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrBuf += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
});

afterEach(async () => {
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  try {
    await removeTempDirectory(tmpDir);
  } catch (error) {
    if (!isTransientFsLockError(error)) {
      throw error;
    }
  }
});

describe("longmemeval --snapshot-out CLI", () => {
  it("advertises --snapshot-out in the longmemeval help line", async () => {
    const exitCode = await runCli(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdoutBuf).toContain("--snapshot-out <db>");
  });

  it(
    "rejects a synthetic pinned substrate before API or snapshot artifacts",
    async () => {
      await writeLongMemEvalFixtureDataset({
        variant: VARIANT,
        dataDir,
        pinnedMetaRoot,
        questions: [
          buildLongMemEvalFixtureQuestion("q001", "s-001"),
          buildLongMemEvalFixtureQuestion("q002", "s-002")
        ]
      });
      const snapshotDbPath = join(tmpDir, "snapshot.db");
      const historyRoot = join(tmpDir, "history");

      const exitCode = await runCli([
        "longmemeval",
        "--variant",
        "oracle",
        "--limit",
        "2",
        "--data-dir",
        dataDir,
        "--pinned-meta-root",
        pinnedMetaRoot,
        "--snapshot-out",
        snapshotDbPath,
        "--history-root",
        historyRoot,
        "--extraction-cache-root",
        join(tmpDir, "extraction-cache")
      ]);

      expect(exitCode).toBe(2);
      expect(stderrBuf).toContain(
        "snapshot production requires canonical pinned dataset authority"
      );
      expect(existsSync(snapshotDbPath)).toBe(false);
      expect(existsSync(snapshotManifestPath(snapshotDbPath))).toBe(false);
      expect(existsSync(snapshotSidecarPath(snapshotDbPath))).toBe(false);
      expect(OfficialApiGardenProvider.prototype.compile).not.toHaveBeenCalled();
    },
    120_000
  );
});
