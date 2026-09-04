import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runMergeCli } from "./cli-merge-dataset-fixture.js";
import { runMergeLongMemEvalCommand } from "../../../cli/merge/command/merge-command.js";
import { loadMergeShards } from "../../../cli/merge/command/merge-command-shards.js";
import { LongMemEvalDiagnosticsSpool } from "../../../diagnostics/spool.js";
// @ts-expect-error The executable MJS verifier is intentionally outside the package declaration surface.
import { loadEvidenceBundle } from "../../../../scripts/longmemeval-replay/contract.mjs";
import {
  makeShardDiagnostics,
  makeShardKpi,
  makeValidShardDiagnostics,
  scenarioRow,
  withEligibleMeasurementContract,
  writeShardRoot
} from "./cli-merge-validations-fixture.js";
import {
  archiveRoot,
  candidate,
  cleanupRoots,
  provenance,
  question,
  roots,
  setupShard,
  streamedQuestion,
  writeProvenance
} from "./cli-merge-evidence-fixture.js";

afterEach(cleanupRoots);

describe("merge-longmemeval evidence bundle", () => {
  it("streams shard full diagnostics into a compact merge spool", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "merge-evidence-spool-"));
    roots.push(root);
    const shard = path.join(root, "shard");
    await writeShardRoot(shard, makeShardKpi({
      evaluated_count: 1,
      kpi: {
        ...makeShardKpi().kpi,
        per_scenario: [scenarioRow("q-stream", true)]
      }
    }), makeShardDiagnostics({ questions: [question("q-stream", [candidate()])] }));
    await writeProvenance(shard, provenance(0, 1));
    const spool = await LongMemEvalDiagnosticsSpool.create();
    try {
      const loaded = await loadMergeShards([shard], spool);
      expect(loaded.questionDiagnostics[0]?.candidates).toEqual([]);
      expect(loaded.questionDiagnostics[0]?.query_probes).not.toBeNull();
      expect(spool.questionCount).toBe(1);
      const artifactPath = path.join(root, "merged.json.gz");
      await spool.writeGzipArtifact(
        artifactPath,
        makeValidShardDiagnostics({ questions: loaded.questionDiagnostics })
      );
      const persisted = JSON.parse(gunzipSync(await readFile(artifactPath)).toString("utf8")) as {
        questions: Array<{ candidates: Array<{ origin_plane: string }> }>;
      };
      expect(persisted.questions[0]?.candidates[0]?.origin_plane).toBe("workspace_local");
    } finally {
      await spool.dispose();
    }
  });

  it("rejects compact diagnostics whose streamed artifact is truncated", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "merge-evidence-truncated-"));
    roots.push(root);
    const shard = path.join(root, "shard");
    const artifactReference = path.posix.join(
      "public", "2026-05-14T100000Z-abc1234", "full.json.gz"
    );
    const artifactPath = path.join(shard, ".bench-artifacts", artifactReference);
    await mkdir(path.dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, gzipSync(JSON.stringify(makeShardDiagnostics({
      questions: [streamedQuestion("q-one")]
    }))));
    await writeShardRoot(shard, makeShardKpi({ evaluated_count: 2 }), makeShardDiagnostics({
      compact_schema_version: 1,
      question_count: 2,
      full_diagnostics_artifact_path: artifactReference,
      questions: undefined
    }));
    const spool = await LongMemEvalDiagnosticsSpool.create();
    try {
      await expect(loadMergeShards([shard], spool)).rejects.toThrow(
        "compact diagnostics question_count=2 does not match streamed question count=1"
      );
    } finally {
      await spool.dispose();
    }
  });

  it("rejects a current compact merge whose evaluated total differs from the spool", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "merge-evidence-count-drift-"));
    roots.push(root);
    const shard = path.join(root, "shard");
    const artifactReference = path.posix.join(
      "public", "2026-05-14T100000Z-abc1234", "full.json.gz"
    );
    const artifactPath = path.join(shard, ".bench-artifacts", artifactReference);
    await mkdir(path.dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, gzipSync(JSON.stringify(makeShardDiagnostics({
      questions: [streamedQuestion("q-one")]
    }))));
    await writeShardRoot(shard, makeShardKpi({
      evaluated_count: 2,
      kpi: {
        ...makeShardKpi().kpi,
        per_scenario: [scenarioRow("q-one", true)]
      }
    }), makeShardDiagnostics({
      compact_schema_version: 1,
      question_count: 1,
      full_diagnostics_artifact_path: artifactReference,
      questions: undefined
    }));
    const spool = await LongMemEvalDiagnosticsSpool.create();
    try {
      await expect(loadMergeShards([shard], spool)).rejects.toThrow(
        "merged evaluated_count=2 does not match diagnostics spool question count=1"
      );
    } finally {
      await spool.dispose();
    }
  });

  it("rejects provenance identity and execution drift", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "merge-evidence-drift-"));
    roots.push(root);
    const shardA = path.join(root, "a");
    const shardB = path.join(root, "b");
    await setupShard(shardA, "q-a", 0);
    await setupShard(shardB, "q-b", 1);
    const drifted = provenance(1, 1);
    await writeProvenance(shardB, {
      ...drifted,
      runtime: { ...drifted.runtime, paired_env: { ALAYA_RECALL_CONF_RHO_PATH: "drift" } }
    });
    expect(await runMergeCli(root, [
      "merge-longmemeval", "--variant", "s", "--history-root", path.join(root, "identity"),
      "--shards", shardA, shardB
    ])).toBe(2);

    const mismatched = provenance(1, 1);
    await writeProvenance(shardB, {
      ...mismatched,
      execution: { ...mismatched.execution, evaluated_count: 2 }
    });
    expect(await runMergeCli(root, [
      "merge-longmemeval", "--variant", "s", "--history-root", path.join(root, "execution"),
      "--shards", shardA, shardB
    ])).toBe(2);
  });

  it("marks all-missing provenance and failed questions partial without hiding rows", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "merge-evidence-missing-"));
    roots.push(root);
    const shard = path.join(root, "shard");
    const history = path.join(root, "history");
    await writeShardRoot(shard, makeShardKpi({
      evaluated_count: 1,
      kpi: {
        ...makeShardKpi().kpi,
        per_scenario: [scenarioRow("q-ok", true)]
      }
    }), makeShardDiagnostics({
      questions: [question("q-ok")],
      question_failures: {
        failed_count: 1,
        completed_count: 1,
        failed_question_ids: ["q-failed"]
      }
    }));

    expect(await runMergeCli(root, [
      "merge-longmemeval", "--variant", "s", "--history-root", history,
      "--shards", shard
    ])).toBe(1);

    const archive = await archiveRoot(history);
    const manifestPath = path.join(archive, "longmemeval-evidence-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      evidence_status: string;
      run: { candidate_pool_complete: boolean; provenance_complete: boolean };
    };
    const ledger = JSON.parse(await readFile(
      path.join(archive, "longmemeval-cohort-ledger.json"), "utf8"
    )) as { question_count: number; rows: Array<{ question_id: string; evidence_status: string }> };
    expect(manifest).toMatchObject({
      evidence_status: "partial",
      run: { candidate_pool_complete: false, provenance_complete: false }
    });
    expect(ledger.question_count).toBe(2);
    expect(ledger.rows[1]).toMatchObject({ question_id: "q-failed", evidence_status: "missing" });
    await expect(loadEvidenceBundle(manifestPath)).rejects.toThrow(
      /legacy synthesized measurement evidence/u
    );
    await expect(loadEvidenceBundle(manifestPath, {
      legacyDiagnostic: true
    })).resolves.toMatchObject({
      cohort: { question_count: 2 }
    });
  });

  it("uses one provenance-completeness verdict for attribution and manifest", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "merge-evidence-unverified-"));
    roots.push(root);
    const shard = path.join(root, "shard");
    const history = path.join(root, "history");
    await writeShardRoot(shard, withEligibleMeasurementContract(makeShardKpi({
      evaluated_count: 1,
      kpi: {
        ...makeShardKpi().kpi,
        r_at_5: 1,
        per_scenario: [scenarioRow("q-unverified", true)]
      }
    })), makeShardDiagnostics({ questions: [question("question-1")] }));
    await writeProvenance(shard, provenance(0, 1));

    expect(await runMergeCli(root, [
      "merge-longmemeval", "--variant", "s", "--history-root", history,
      "--shards", shard
    ])).toBe(1);

    const archive = await archiveRoot(history);
    const kpi = JSON.parse(await readFile(path.join(archive, "kpi.json"), "utf8")) as {
      measurement_attribution: { provenance_complete: boolean };
    };
    const manifest = JSON.parse(await readFile(
      path.join(archive, "longmemeval-evidence-manifest.json"), "utf8"
    )) as { run: { provenance_complete: boolean } };
    expect(kpi.measurement_attribution.provenance_complete).toBe(false);
    expect(manifest.run.provenance_complete).toBe(false);
  });

  it("fail-closes dataset pin/data load for mixed verified and unverified shards", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "merge-mixed-evidence-"));
    roots.push(root);
    const verified = path.join(root, "verified");
    const unverified = path.join(root, "unverified");
    await setupShard(verified, "q-verified", 0);
    await writeShardRoot(
      unverified,
      withEligibleMeasurementContract(makeShardKpi({
        evaluated_count: 1,
        kpi: {
          ...makeShardKpi().kpi,
          r_at_1: 1,
          r_at_5: 1,
          r_at_10: 1,
          per_scenario: [scenarioRow("q-unverified", true)]
        }
      })),
      makeShardDiagnostics()
    );

    const historyRoot = path.join(root, "history");
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      await expect(runMergeLongMemEvalCommand({
        historyRoot,
        shards: [verified, unverified],
        variant: "longmemeval_s",
        dataDir: path.join(root, "missing-data"),
        pinnedMetaRoot: path.join(root, "missing-pinned")
      })).resolves.toBe(2);
      expect(stderr).toHaveBeenCalledWith(expect.stringMatching(
        /dataset not pinned: longmemeval_s/u
      ));
      await expect(readdir(historyRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      stderr.mockRestore();
    }
  });

  it("fail-closes dataset pin/data load when every shard is unverified", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "merge-all-unverified-dataset-"));
    roots.push(root);
    const shard = path.join(root, "shard");
    await writeShardRoot(
      shard,
      withEligibleMeasurementContract(makeShardKpi({
        evaluated_count: 1,
        kpi: {
          ...makeShardKpi().kpi,
          r_at_1: 1,
          r_at_5: 1,
          r_at_10: 1,
          per_scenario: [scenarioRow("q-unverified", true)]
        }
      })),
      makeShardDiagnostics()
    );

    const historyRoot = path.join(root, "history");
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      await expect(runMergeLongMemEvalCommand({
        historyRoot,
        shards: [shard],
        variant: "longmemeval_s",
        dataDir: path.join(root, "missing-data"),
        pinnedMetaRoot: path.join(root, "missing-pinned")
      })).resolves.toBe(2);
      expect(stderr).toHaveBeenCalledWith(expect.stringMatching(
        /dataset not pinned: longmemeval_s/u
      ));
      await expect(readdir(historyRoot)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      stderr.mockRestore();
    }
  });
});
