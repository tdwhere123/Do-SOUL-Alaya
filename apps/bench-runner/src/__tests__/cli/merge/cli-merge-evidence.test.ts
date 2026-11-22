import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runMergeLongMemEvalCommand } from "../../../cli/merge/command/merge-command.js";
import { loadMergeShards } from "../../../cli/merge/command/merge-command-shards.js";
import { LongMemEvalDiagnosticsSpool } from "../../../diagnostics/spool.js";
// @ts-expect-error The executable replay verifier is intentionally outside package declarations.
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
  rewriteShardManifest,
  roots,
  setupShard,
  streamedQuestion,
  writeProvenance
} from "./cli-merge-evidence-fixture.js";
import { createMergeDatasetSource, runMergeCli } from "./cli-merge-dataset-fixture.js";

afterEach(cleanupRoots);

describe("merge-longmemeval evidence bundle", () => {
  it("binds gzip diagnostics, cohort, and exact shard provenance", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "merge-evidence-"));
    roots.push(root);
    const shard = path.join(root, "shard");
    const history = path.join(root, "history");
    const dataset = await createMergeDatasetSource(root);
    await setupShard(shard, "q-1", 0);

    expect(await runMergeCli(root, [
      "merge-longmemeval", "--variant", "s", "--history-root", history,
      "--concurrency", "1", ...dataset.cliArgs, "--shards", shard
    ])).toBe(1);

    const archive = await archiveRoot(history);
    const compact = JSON.parse(await readFile(path.join(archive, "longmemeval-diagnostics.json"), "utf8")) as {
      full_diagnostics_artifact_path: string;
    };
    const manifest = JSON.parse(await readFile(path.join(archive, "longmemeval-evidence-manifest.json"), "utf8")) as {
      evidence_status: string;
      artifacts: Array<{ role: string; path: string; sha256: string; bytes: number }>;
    };
    const roles = manifest.artifacts.map((artifact) => artifact.role);
    const full = manifest.artifacts.find((artifact) => artifact.role === "full_diagnostics")!;
    const fullBytes = await readFile(path.join(archive, full.path));

    expect(compact.full_diagnostics_artifact_path).toMatch(/\.json\.gz$/u);
    expect(manifest.evidence_status).toBe("complete");
    expect(roles).toEqual(expect.arrayContaining([
      "kpi", "report", "diagnostics", "full_diagnostics",
      "cohort_ledger", "comparison", "run_provenance", "shard_run_provenance"
    ]));
    expect(full.bytes).toBe(fullBytes.byteLength);
    expect(full.sha256).toBe(createHash("sha256").update(fullBytes).digest("hex"));
    for (const artifact of manifest.artifacts.filter((item) => !path.isAbsolute(item.path))) {
      const bytes = await readFile(path.join(archive, artifact.path));
      expect(artifact.bytes).toBe(bytes.byteLength);
      expect(artifact.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
    await expect(readFile(path.join(archive, "longmemeval-run-provenance.shard-0.json"), "utf8"))
      .resolves.toContain(`"offset": 0`);
  });

  it("rejects a partially present shard provenance set", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "merge-evidence-partial-"));
    roots.push(root);
    const shardA = path.join(root, "a");
    const shardB = path.join(root, "b");
    await setupShard(shardA, "q-a", 0);
    await writeShardRoot(shardB, makeShardKpi({
      evaluated_count: 1,
      kpi: { ...makeShardKpi().kpi, per_scenario: [{ id: "q-b", version: 1, hit_at_5: true, tier: "warm" }] }
    }), makeShardDiagnostics({ questions: [question("q-b")] }));

    expect(await runMergeCli(root, [
      "merge-longmemeval", "--variant", "s", "--history-root", path.join(root, "history"), "--shards", shardA, shardB
    ])).toBe(2);
  });

  it("canonicalizes reversed shards and binds the final selection ledger", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "merge-evidence-two-"));
    roots.push(root);
    const shardA = path.join(root, "a");
    const shardB = path.join(root, "b");
    const history = path.join(root, "history");
    const dataset = await createMergeDatasetSource(root);
    await setupShard(shardA, "q-a", 0);
    await setupShard(shardB, "q-b", 1);

    expect(await runMergeCli(root, [
      "merge-longmemeval", "--variant", "s", "--history-root", history, ...dataset.cliArgs, "--shards", shardB, shardA
    ])).toBe(1);

    const archive = await archiveRoot(history);
    const aggregate = JSON.parse(await readFile(path.join(archive, "longmemeval-run-provenance.json"), "utf8")) as {
      gate_eligible: boolean; requested_concurrency: number | null; evaluated_count: number;
      executed_dist: { sha256: string }; shards: Array<{ execution: { offset: number } }>;
    };
    expect(aggregate).toMatchObject({
      gate_eligible: false, requested_concurrency: null, evaluated_count: 2, executed_dist: { sha256: "f".repeat(64) }
    });
    expect(aggregate.shards.map((shard) => shard.execution.offset)).toEqual([0, 1]);
    await expect(readFile(path.join(archive, "longmemeval-evidence-manifest.json"), "utf8"))
      .resolves.toContain(`"evidence_status": "partial"`);
    const kpi = JSON.parse(await readFile(path.join(archive, "kpi.json"), "utf8")) as {
      selection_contract: { selected_count: number; cohort_assignment_digest: string };
      kpi: { per_scenario: Array<{ id: string }> };
    };
    const ledger = JSON.parse(await readFile(path.join(archive, "longmemeval-cohort-ledger.json"), "utf8")) as {
      selection_contract: { selected_count: number; cohort_assignment_digest: string };
      rows: Array<{ question_id: string }>;
    };
    expect(kpi.kpi.per_scenario.map((row) => row.id)).toEqual(["q-a", "q-b"]);
    expect(ledger.rows.map((row) => row.question_id)).toEqual(["q-a", "q-b"]);
    expect(ledger.selection_contract).toEqual(kpi.selection_contract);
    await expect(loadEvidenceBundle(path.join(archive, "longmemeval-evidence-manifest.json"))).resolves.toMatchObject({
      diagnostics: { questions: [{ question_id: "q-a" }, { question_id: "q-b" }] }
    });
  });

  it("rejects a gap between verified shard execution ranges", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "merge-evidence-gap-"));
    roots.push(root);
    const shardA = path.join(root, "a");
    const shardB = path.join(root, "b");
    await setupShard(shardA, "q-a", 0);
    await setupShard(shardB, "q-b", 2);

    expect(await runMergeCli(root, [
      "merge-longmemeval", "--variant", "s", "--history-root", path.join(root, "history"), "--shards", shardB, shardA
    ])).toBe(2);
  });

  it("rejects a shard evidence manifest whose bundle hash was changed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "merge-evidence-bundle-drift-"));
    roots.push(root);
    const shard = path.join(root, "shard");
    await setupShard(shard, "q-bundle", 0);
    const manifestPath = path.join(shard, "public", "2026-05-14T100000Z-abc1234", "longmemeval-evidence-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { bundle_sha256: string };
    await writeFile(manifestPath, JSON.stringify({ ...manifest, bundle_sha256: "0".repeat(64) }));
    const spool = await LongMemEvalDiagnosticsSpool.create();
    try {
      await expect(loadMergeShards([shard], spool)).rejects.toThrow(/bundle sha256 mismatch/u);
    } finally {
      await spool.dispose();
    }
  });

  it("rejects a self-consistent partial shard evidence manifest", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "merge-evidence-partial-manifest-"));
    roots.push(root);
    const shard = path.join(root, "shard");
    await setupShard(shard, "q-partial", 0);
    await rewriteShardManifest(shard, (manifest) => ({
      ...manifest.run, candidate_pool_complete: false, provenance_complete: false
    }));
    const spool = await LongMemEvalDiagnosticsSpool.create();
    try {
      await expect(loadMergeShards([shard], spool)).rejects.toThrow(/complete shard evidence/u);
    } finally {
      await spool.dispose();
    }
  });

  it("rejects shard evidence run bindings that disagree with KPI", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "merge-evidence-run-binding-"));
    roots.push(root);
    const shard = path.join(root, "shard");
    await setupShard(shard, "q-binding", 0);
    await rewriteShardManifest(shard, (manifest) => ({
      ...manifest.run,
      dataset_sha256: "e".repeat(64),
      selection_contract: manifest.run.selection_contract === undefined
        ? undefined
        : { ...manifest.run.selection_contract, dataset_sha256: "e".repeat(64) }
    }));
    const spool = await LongMemEvalDiagnosticsSpool.create();
    try {
      await expect(loadMergeShards([shard], spool)).rejects.toThrow(/dataset binding/u);
    } finally {
      await spool.dispose();
    }
  });

  it("reads a new-layout external gzip through containment and refuses an escaping reference", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "merge-local-history-"));
    roots.push(root);
    const shard = path.join(root, ".bench-artifacts/history");
    const reference = "public/2026-05-14T100000Z-abc1234/full.json.gz";
    const artifactPath = path.join(root, ".bench-artifacts", reference);
    await mkdir(path.dirname(artifactPath), { recursive: true });
    const bytes = gzipSync(JSON.stringify(makeShardDiagnostics({ questions: [streamedQuestion("q-local")] })));
    await writeFile(artifactPath, bytes);
    const kpi = makeShardKpi({ evaluated_count: 1, kpi: { ...makeShardKpi().kpi, per_scenario: [scenarioRow("q-local", true)] } });
    const compact = makeShardDiagnostics({
      compact_schema_version: 1, question_count: 1, full_diagnostics_artifact_path: reference, questions: undefined
    });
    await writeShardRoot(shard, kpi, compact);
    const spool = await LongMemEvalDiagnosticsSpool.create();
    try {
      const loaded = await loadMergeShards([shard], spool);
      expect(loaded.questionDiagnostics.map(q => q.question_id)).toEqual(["q-local"]);
      expect(await readFile(artifactPath)).toEqual(bytes);
      await writeFile(path.join(root, "outside.json.gz"), bytes);
      await writeShardRoot(shard, kpi, { ...compact, full_diagnostics_artifact_path: "../../outside.json.gz" });
      await expect(loadMergeShards([shard], spool)).rejects.toThrow(/artifact|contain|relative|traversal/u);
    } finally {
      await spool.dispose();
    }
  });

  it("streams shard full diagnostics into a compact merge spool", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "merge-evidence-spool-"));
    roots.push(root);
    const shard = path.join(root, "shard");
    await writeShardRoot(
      shard,
      makeShardKpi({ evaluated_count: 1, kpi: { ...makeShardKpi().kpi, per_scenario: [scenarioRow("q-stream", true)] } }),
      makeShardDiagnostics({ questions: [question("q-stream", [candidate()])] })
    );
    await writeProvenance(shard, provenance(0, 1));
    const spool = await LongMemEvalDiagnosticsSpool.create();
    try {
      const loaded = await loadMergeShards([shard], spool);
      expect(loaded.questionDiagnostics[0]?.candidates).toEqual([]);
      expect(loaded.questionDiagnostics[0]?.query_probes).not.toBeNull();
      expect(spool.questionCount).toBe(1);
      const artifactPath = path.join(root, "merged.json.gz");
      await spool.writeGzipArtifact(artifactPath, makeValidShardDiagnostics({ questions: loaded.questionDiagnostics }));
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
    const artifactReference = path.posix.join("public", "2026-05-14T100000Z-abc1234", "full.json.gz");
    const artifactPath = path.join(shard, ".bench-artifacts", artifactReference);
    await mkdir(path.dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, gzipSync(JSON.stringify(makeShardDiagnostics({ questions: [streamedQuestion("q-one")] }))));
    await writeShardRoot(shard, makeShardKpi({ evaluated_count: 2 }), makeShardDiagnostics({
      compact_schema_version: 1, question_count: 2, full_diagnostics_artifact_path: artifactReference, questions: undefined
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
    const artifactReference = path.posix.join("public", "2026-05-14T100000Z-abc1234", "full.json.gz");
    const artifactPath = path.join(shard, ".bench-artifacts", artifactReference);
    await mkdir(path.dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, gzipSync(JSON.stringify(makeShardDiagnostics({ questions: [streamedQuestion("q-one")] }))));
    await writeShardRoot(shard, makeShardKpi({
      evaluated_count: 2, kpi: { ...makeShardKpi().kpi, per_scenario: [scenarioRow("q-one", true)] }
    }), makeShardDiagnostics({
      compact_schema_version: 1, question_count: 1, full_diagnostics_artifact_path: artifactReference, questions: undefined
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
    await writeProvenance(shardB, { ...drifted, runtime: { ...drifted.runtime, paired_env: { ALAYA_RECALL_ANSWERS_WITH: "drift" } } });
    expect(await runMergeCli(root, [
      "merge-longmemeval", "--variant", "s", "--history-root", path.join(root, "identity"), "--shards", shardA, shardB
    ])).toBe(2);

    const mismatched = provenance(1, 1);
    await writeProvenance(shardB, { ...mismatched, execution: { ...mismatched.execution, evaluated_count: 2 } });
    expect(await runMergeCli(root, [
      "merge-longmemeval", "--variant", "s", "--history-root", path.join(root, "execution"), "--shards", shardA, shardB
    ])).toBe(2);
  });

  it("marks all-missing provenance and failed questions partial without hiding rows", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "merge-evidence-missing-"));
    roots.push(root);
    const shard = path.join(root, "shard");
    const history = path.join(root, "history");
    await writeShardRoot(shard, makeShardKpi({
      evaluated_count: 1, kpi: { ...makeShardKpi().kpi, per_scenario: [scenarioRow("q-ok", true)] }
    }), makeShardDiagnostics({
      questions: [question("q-ok")],
      question_failures: { failed_count: 1, completed_count: 1, failed_question_ids: ["q-failed"] }
    }));

    expect(await runMergeCli(root, ["merge-longmemeval", "--variant", "s", "--history-root", history, "--shards", shard])).toBe(1);
    const archive = await archiveRoot(history);
    const manifestPath = path.join(archive, "longmemeval-evidence-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      evidence_status: string;
      run: { candidate_pool_complete: boolean; provenance_complete: boolean };
    };
    const ledger = JSON.parse(await readFile(path.join(archive, "longmemeval-cohort-ledger.json"), "utf8")) as {
      question_count: number;
      rows: Array<{ question_id: string; evidence_status: string }>;
    };
    expect(manifest).toMatchObject({
      evidence_status: "partial", run: { candidate_pool_complete: false, provenance_complete: false }
    });
    expect(ledger.question_count).toBe(2);
    expect(ledger.rows[1]).toMatchObject({ question_id: "q-failed", evidence_status: "missing" });
    await expect(loadEvidenceBundle(manifestPath)).rejects.toThrow(/legacy synthesized measurement evidence/u);
    await expect(loadEvidenceBundle(manifestPath, { legacyDiagnostic: true })).resolves.toMatchObject({
      cohort: { question_count: 2 }
    });
  });

  it("uses one provenance-completeness verdict for attribution and manifest", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "merge-evidence-unverified-"));
    roots.push(root);
    const shard = path.join(root, "shard");
    const history = path.join(root, "history");
    await writeShardRoot(shard, withEligibleMeasurementContract(makeShardKpi({
      evaluated_count: 1, kpi: { ...makeShardKpi().kpi, r_at_5: 1, per_scenario: [scenarioRow("q-unverified", true)] }
    })), makeShardDiagnostics({ questions: [question("question-1")] }));
    await writeProvenance(shard, provenance(0, 1));

    expect(await runMergeCli(root, ["merge-longmemeval", "--variant", "s", "--history-root", history, "--shards", shard])).toBe(1);
    const archive = await archiveRoot(history);
    const kpi = JSON.parse(await readFile(path.join(archive, "kpi.json"), "utf8")) as {
      measurement_attribution: { provenance_complete: boolean };
    };
    const manifest = JSON.parse(await readFile(path.join(archive, "longmemeval-evidence-manifest.json"), "utf8")) as {
      run: { provenance_complete: boolean };
    };
    expect(kpi.measurement_attribution.provenance_complete).toBe(false);
    expect(manifest.run.provenance_complete).toBe(false);
  });

  it.each([false, true])(
    "fail-closes dataset pin/data load (mixedWithVerified=%s)",
    async (mixedWithVerified) => {
      const root = await mkdtemp(path.join(tmpdir(), mixedWithVerified ? "merge-mixed-evidence-" : "merge-all-unverified-dataset-"));
      roots.push(root);
      const shards: string[] = [];
      if (mixedWithVerified) {
        const verified = path.join(root, "verified");
        await setupShard(verified, "q-verified", 0);
        shards.push(verified);
      }
      const unverified = path.join(root, "unverified");
      await writeShardRoot(
        unverified,
        withEligibleMeasurementContract(makeShardKpi({
          evaluated_count: 1,
          kpi: { ...makeShardKpi().kpi, r_at_1: 1, r_at_5: 1, r_at_10: 1, per_scenario: [scenarioRow("q-unverified", true)] }
        })),
        makeShardDiagnostics()
      );
      shards.push(unverified);

      const historyRoot = path.join(root, "history");
      const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      try {
        await expect(runMergeLongMemEvalCommand({
          historyRoot,
          shards,
          variant: "longmemeval_s",
          dataDir: path.join(root, "missing-data"),
          pinnedMetaRoot: path.join(root, "missing-pinned")
        })).resolves.toBe(2);
        expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/dataset not pinned: longmemeval_s/u));
        await expect(readdir(historyRoot)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        stderr.mockRestore();
      }
    }
  );
});
