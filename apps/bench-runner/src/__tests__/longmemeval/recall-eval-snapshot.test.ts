import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OfficialApiGardenProvider } from "@do-soul/alaya-soul";
import { runLongMemEval } from "../../longmemeval/runner.js";
import { runRecallEval } from "../../longmemeval/recall-eval.js";
import {
  LONGMEMEVAL_RUN_PROVENANCE_FILENAME,
  LongMemEvalRunProvenanceSchema
} from "../../longmemeval/provenance/run.js";
import {
  readSnapshotManifest,
  snapshotManifestPath,
  snapshotSidecarPath
} from "../../longmemeval/snapshot.js";
import {
  buildLongMemEvalFixtureQuestion as buildQuestion,
  writeLongMemEvalFixtureDataset
} from "./longmemeval-fixture.js";

// @anchor recall-eval-end-to-end: seed a tiny dataset through the real bench
// daemon (no LLM — no-credentials offline seed path), snapshot the seeded DB,
// then run recall-eval against the snapshot. Asserts the fast loop never
// re-seeds (it restores the snapshot) and that the same snapshot + same query
// yields identical R@5 across two runs (determinism).

let tmpDir: string;
let dataDir: string;
let pinnedMetaRoot: string;
const VARIANT = "longmemeval_oracle";

async function writeFixtureDataset(
  questions: readonly Parameters<typeof writeLongMemEvalFixtureDataset>[0]["questions"][number][]
): Promise<void> {
  await writeLongMemEvalFixtureDataset({
    variant: VARIANT,
    dataDir,
    pinnedMetaRoot,
    questions
  });
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "recall-eval-"));
  dataDir = join(tmpDir, "data");
  pinnedMetaRoot = join(tmpDir, "pinned");
  await mkdir(dataDir, { recursive: true });
  await mkdir(pinnedMetaRoot, { recursive: true });
  // No-credentials offline seed path; the model is never used for a live call.
  // Paired with an isolated extractionCacheRoot (no manifest -> first-ever-build
  // preflight), this model is arbitrary: the test is decoupled from the
  // production extraction-cache manifest's model.
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", "test-extraction-model");
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
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(tmpDir, { recursive: true, force: true });
});

describe("recall-eval against a seeded-DB snapshot", () => {
  it(
    "seeds + snapshots, then recall-eval scores from the snapshot without re-seeding",
    async () => {
      await writeFixtureDataset([
        buildQuestion("q001", "s-001"),
        buildQuestion("q002", "s-002")
      ]);
      const snapshotDbPath = join(tmpDir, "snapshot.db");
      const seedHistoryRoot = join(tmpDir, "seed-history");

      const seedResult = await runLongMemEval({
        variant: VARIANT,
        historyRoot: seedHistoryRoot,
        dataDir,
        pinnedMetaRoot,
        snapshotOut: snapshotDbPath,
        extractionCacheRoot: join(tmpDir, "extraction-cache")
      });
      expect(seedResult.payload.evaluated_count).toBe(2);
      expect(existsSync(snapshotDbPath)).toBe(true);
      expect(existsSync(snapshotManifestPath(snapshotDbPath))).toBe(true);
      expect(existsSync(snapshotSidecarPath(snapshotDbPath))).toBe(true);

      const manifest = readSnapshotManifest(snapshotDbPath);
      expect(manifest.question_count).toBe(2);
      expect(manifest.variant).toBe(VARIANT);

      const evalHistoryRoot = join(tmpDir, "eval-history");
      const recallResult = await runRecallEval({
        snapshotDbPath,
        variant: VARIANT,
        historyRoot: evalHistoryRoot
      });
      expect(recallResult.payload.evaluated_count).toBe(2);
      // The recall-eval KPI carries the recall-derived fields.
      expect(recallResult.payload.kpi.r_at_5).toBeGreaterThanOrEqual(0);
      expect(recallResult.payload.kpi.r_at_5).toBeLessThanOrEqual(1);
      expect(recallResult.payload.kpi.per_scenario).toHaveLength(2);
      // Gate-only fields are NOT recomputed: recall-eval reports zeroed seed
      // truncation and omits seed_extraction_path (inherited from the manifest).
      expect(recallResult.payload.kpi.seed_extraction_path).toBeUndefined();
      expect(recallResult.payload.kpi.seed_truncation.seed_turns_truncated).toBe(0);
      expect((recallResult.payload as typeof recallResult.payload & {
        recall_eval_attribution: { status: string; gate_eligible: boolean };
      }).recall_eval_attribution).toMatchObject({
        status: "legacy_unattributed",
        gate_eligible: false
      });
      const archivedKpi = JSON.parse(await readFile(recallResult.kpiPath, "utf8")) as {
        recall_eval_attribution?: { status: string; gate_eligible: boolean };
      };
      expect(archivedKpi.recall_eval_attribution).toEqual(
        expect.objectContaining({ gate_eligible: false })
      );
      const provenance = LongMemEvalRunProvenanceSchema.parse(JSON.parse(
        await readFile(
          join(dirname(recallResult.kpiPath), LONGMEMEVAL_RUN_PROVENANCE_FILENAME),
          "utf8"
        )
      ));
      expect(provenance).toMatchObject({
        code: { commit_sha7: recallResult.payload.alaya_commit },
        execution: { protocol: "sequential", concurrency: 1, evaluated_count: 2 },
        recall_config: { conf_slice_compatibility: false }
      });
      expect(OfficialApiGardenProvider.prototype.compile).not.toHaveBeenCalled();
    },
    120_000
  );

  it(
    "does not create an owned recall root when ONNX attribution fails",
    async () => {
      await writeFixtureDataset([buildQuestion("q001", "s-001")]);
      const snapshotDbPath = join(tmpDir, "snapshot.db");
      await runLongMemEval({
        variant: VARIANT,
        historyRoot: join(tmpDir, "seed-history"),
        dataDir,
        pinnedMetaRoot,
        snapshotOut: snapshotDbPath,
        extractionCacheRoot: join(tmpDir, "extraction-cache")
      });
      const modelCacheRoot = join(tmpDir, "model-cache");
      const outsideModel = join(tmpDir, "outside-model");
      await mkdir(modelCacheRoot, { recursive: true });
      await mkdir(outsideModel, { recursive: true });
      await writeFile(join(outsideModel, "model.onnx"), "fixture", "utf8");
      await symlink(outsideModel, join(modelCacheRoot, "linked"), "dir");
      vi.stubEnv("ALAYA_RECALL_EVAL_EMBEDDING", "env");
      vi.stubEnv("ALAYA_LOCAL_EMBEDDING_MODEL", "linked");
      vi.stubEnv("ALAYA_LOCAL_EMBEDDING_CACHE_DIR", modelCacheRoot);
      const before = await listOwnedRecallRoots();
      const stderr: string[] = [];
      vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        stderr.push(String(chunk));
        return true;
      });

      await expect(runRecallEval({
        snapshotDbPath,
        variant: VARIANT,
        historyRoot: join(tmpDir, "failed-eval-history")
      })).rejects.toThrow(/artifact tree/u);

      expect(await listOwnedRecallRoots()).toEqual(before);
      expect(stderr.join("")).not.toMatch(/retained failed run evidence.*alaya-recall-eval/u);
    },
    120_000
  );

  it(
    "is deterministic: same snapshot + same query => identical R@5 across two runs",
    async () => {
      await writeFixtureDataset([
        buildQuestion("q001", "s-001"),
        buildQuestion("q002", "s-002"),
        buildQuestion("q003", "s-003")
      ]);
      const snapshotDbPath = join(tmpDir, "snapshot.db");
      await runLongMemEval({
        variant: VARIANT,
        historyRoot: join(tmpDir, "seed-history"),
        dataDir,
        pinnedMetaRoot,
        snapshotOut: snapshotDbPath,
        extractionCacheRoot: join(tmpDir, "extraction-cache")
      });

      const firstRun = await runRecallEval({
        snapshotDbPath,
        variant: VARIANT,
        historyRoot: join(tmpDir, "eval-history-1")
      });
      const secondRun = await runRecallEval({
        snapshotDbPath,
        variant: VARIANT,
        historyRoot: join(tmpDir, "eval-history-2")
      });

      // invariant: recall ranking is deterministic on a fixed snapshot. The
      // recall path's randomUUID()-derived taskSurface / delivery ids are audit
      // identifiers only — they do not enter fusion/scoring — so R@K and the
      // per-question hit verdicts are bit-identical across runs.
      expect(secondRun.payload.kpi.r_at_5).toBe(firstRun.payload.kpi.r_at_5);
      expect(secondRun.payload.kpi.r_at_1).toBe(firstRun.payload.kpi.r_at_1);
      expect(secondRun.payload.kpi.r_at_10).toBe(firstRun.payload.kpi.r_at_10);

      const firstHits = firstRun.payload.kpi.per_scenario
        .map((row) => `${row.id}:${row.hit_at_5 ? 1 : 0}`)
        .sort();
      const secondHits = secondRun.payload.kpi.per_scenario
        .map((row) => `${row.id}:${row.hit_at_5 ? 1 : 0}`)
        .sort();
      expect(secondHits).toEqual(firstHits);

      // N4: prove determinism at RANK granularity, not just hit/miss. The
      // per-question delivered object_id lists must be deep-equal in ORDER
      // across both runs — randomUUID() never perturbs the ranking.
      const firstDelivered = Object.fromEntries(firstRun.perQuestionDelivered);
      const secondDelivered = Object.fromEntries(secondRun.perQuestionDelivered);
      expect(Object.keys(secondDelivered).sort()).toEqual(
        Object.keys(firstDelivered).sort()
      );
      // At least one question must actually deliver results, else the rank-list
      // assertion would be vacuously true on empty lists.
      const totalDelivered = Object.values(firstDelivered).reduce(
        (sum, ids) => sum + ids.length,
        0
      );
      expect(totalDelivered).toBeGreaterThan(0);
      for (const questionId of Object.keys(firstDelivered)) {
        expect(secondDelivered[questionId]).toEqual(firstDelivered[questionId]);
      }
      expect(OfficialApiGardenProvider.prototype.compile).not.toHaveBeenCalled();
    },
    120_000
  );
});

async function listOwnedRecallRoots(): Promise<readonly string[]> {
  return (await readdir(tmpdir()))
    .filter((name) => name.startsWith("alaya-recall-eval-"))
    .sort();
}
