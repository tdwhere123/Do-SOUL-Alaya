import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OfficialApiGardenProvider } from "@do-soul/alaya-soul";
import { runCli } from "../../cli/index.js";
import {
  snapshotManifestPath,
  snapshotSidecarPath
} from "../../longmemeval/snapshot.js";
import {
  buildLongMemEvalFixtureQuestion,
  writeLongMemEvalFixtureDataset
} from "../longmemeval/longmemeval-fixture.js";
import {
  isTransientFsLockError,
  removeTempDirectory
} from "../support/temp-cleanup.js";

// @anchor cli-snapshot-out-e2e — producer half of the recall-eval fast
// loop must be CLI-reachable. Drives `longmemeval --snapshot-out` through the
// real CLI on a tiny fixture via the no-credentials offline seed path (NO live
// LLM) and asserts the three-file snapshot lands, then recall-eval --snapshot
// reads it. cross-file: apps/bench-runner/src/longmemeval/runner.ts (snapshotOut)

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
  // No-credentials offline seed path; the model is never used for a live call.
  // Paired with an isolated --extraction-cache-root (no manifest ->
  // first-ever-build preflight), this model is arbitrary: the test is decoupled
  // from the production extraction-cache manifest's model.
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", "test-extraction-model");
  vi.stubEnv("ALAYA_BENCH_EXTRACTION_REQUEST_PROFILE", "provider-default-v1");
  vi.stubEnv("ALAYA_OFFICIAL_GARDEN_SECRET_REF", "");
  vi.stubEnv("ALAYA_HOSTILE_DUMMY_KEY", "must-not-be-used");
  vi.stubEnv("ALAYA_BENCH_ALLOW_LIVE_EXTRACTION", "0");
  vi.stubEnv("OFFICIAL_API_GARDEN_PROVIDER_URL", "http://127.0.0.1:1/v1");
  vi.stubEnv("ALAYA_GARDEN_PROVIDER_KIND", "local_heuristics");
  vi.stubEnv("ALAYA_INGEST_RECONCILIATION_ENABLED", "0");
  vi.stubEnv("ALAYA_CONFLICT_DETECTION_ENABLED", "0");
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
    "produces <db> + .manifest.json + .sidecar.json from the offline seed path",
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

      // exit 2 == arg/IO error. The offline no-credentials seed path is a
      // degraded-provenance run (no_credentials_fallback) so its verdict exit
      // code is 1 by design; snapshot production happens
      // before the verdict. Assert no arg/IO error and that the snapshot landed.
      expect(exitCode).not.toBe(2);
      expect(stderrBuf).not.toMatch(/alaya-bench-runner longmemeval:/);
      expect(existsSync(snapshotDbPath)).toBe(true);
      expect(existsSync(snapshotManifestPath(snapshotDbPath))).toBe(true);
      expect(existsSync(snapshotSidecarPath(snapshotDbPath))).toBe(true);
      expect(stdoutBuf).toContain("[longmemeval snapshot] wrote 2 questions");

      // The consumer half reads it back out: recall-eval --snapshot scores R@5
      // (exit 2 would mean it could not read the snapshot).
      const evalHistoryRoot = join(tmpDir, "eval-history");
      const recallExit = await runCli([
        "recall-eval",
        "--snapshot",
        snapshotDbPath,
        "--variant",
        "oracle",
        "--history-root",
        evalHistoryRoot
      ]);
      expect(recallExit).not.toBe(2);
      const manifest = JSON.parse(
        await readFile(snapshotManifestPath(snapshotDbPath), "utf8")
      ) as {
        question_count: number;
        variant: string;
        artifact_integrity?: { db_sha256: string; sidecar_sha256: string };
        run_provenance?: { runtime: { embedding_provider_label: string } };
        attribution?: { status: string; gate_eligible: boolean };
      };
      expect(manifest.question_count).toBe(2);
      expect(manifest.variant).toBe(VARIANT);
      expect(manifest.artifact_integrity?.db_sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(manifest.artifact_integrity?.sidecar_sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(manifest.run_provenance?.runtime.embedding_provider_label).toBe(
        "none"
      );
      expect(manifest.attribution).toEqual({
        status: "legacy_unattributed",
        gate_eligible: false
      });
      expect(OfficialApiGardenProvider.prototype.compile).not.toHaveBeenCalled();
    },
    120_000
  );
});
