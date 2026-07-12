import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../../cli/index.js";
import { loadMergeShards } from "../../cli/merge-command-shards.js";
import { LongMemEvalDiagnosticsSpool } from "../../longmemeval/diagnostics/spool.js";
import {
  makeShardDiagnostics,
  makeShardKpi,
  writeShardRoot
} from "./cli-merge-validations-fixture.js";
import {
  archiveRoot,
  cleanupRoots,
  question,
  rewriteShardManifest,
  roots,
  setupShard
} from "./cli-merge-evidence-fixture.js";

afterEach(cleanupRoots);

describe("merge-longmemeval evidence bundle", () => {
  it("binds gzip diagnostics, cohort, and exact shard provenance", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "merge-evidence-"));
    roots.push(root);
    const shard = path.join(root, "shard");
    const history = path.join(root, "history");
    await setupShard(shard, "q-1", 0);

    expect(await runCli([
      "merge-longmemeval", "--variant", "s", "--history-root", history,
      "--shards", shard
    ])).toBe(0);

    const archive = await archiveRoot(history);
    const compact = JSON.parse(await readFile(
      path.join(archive, "longmemeval-diagnostics.json"), "utf8"
    )) as { full_diagnostics_artifact_path: string };
    const manifest = JSON.parse(await readFile(
      path.join(archive, "longmemeval-evidence-manifest.json"), "utf8"
    )) as { evidence_status: string; artifacts: Array<{ role: string; path: string; sha256: string; bytes: number }> };
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
    await expect(readFile(
      path.join(archive, "longmemeval-run-provenance.shard-0.json"), "utf8"
    )).resolves.toContain(`"offset": 0`);
  });

  it("rejects a partially present shard provenance set", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "merge-evidence-partial-"));
    roots.push(root);
    const shardA = path.join(root, "a");
    const shardB = path.join(root, "b");
    await setupShard(shardA, "q-a", 0);
    await writeShardRoot(shardB, makeShardKpi({
      evaluated_count: 1,
      kpi: {
        ...makeShardKpi().kpi,
        per_scenario: [{ id: "q-b", version: 1, hit_at_5: true, tier: "warm" }]
      }
    }), makeShardDiagnostics({ questions: [question("q-b")] }));

    expect(await runCli([
      "merge-longmemeval", "--variant", "s", "--history-root", path.join(root, "history"),
      "--shards", shardA, shardB
    ])).toBe(2);
  });

  it("preserves coherent provenance for two shards", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "merge-evidence-two-"));
    roots.push(root);
    const shardA = path.join(root, "a");
    const shardB = path.join(root, "b");
    const history = path.join(root, "history");
    await setupShard(shardA, "q-a", 0);
    await setupShard(shardB, "q-b", 1);

    expect(await runCli([
      "merge-longmemeval", "--variant", "s", "--history-root", history,
      "--shards", shardA, shardB
    ])).toBe(0);

    const archive = await archiveRoot(history);
    const aggregate = JSON.parse(await readFile(
      path.join(archive, "longmemeval-run-provenance.json"), "utf8"
    )) as { gate_eligible: boolean; requested_concurrency: number | null; evaluated_count: number; executed_dist: { sha256: string }; shards: Array<{ execution: { offset: number } }> };
    expect(aggregate).toMatchObject({
      gate_eligible: true,
      requested_concurrency: null,
      evaluated_count: 2,
      executed_dist: { sha256: "f".repeat(64) }
    });
    expect(aggregate.shards.map((shard) => shard.execution.offset)).toEqual([0, 1]);
  });

  it("rejects a shard evidence manifest whose bundle hash was changed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "merge-evidence-bundle-drift-"));
    roots.push(root);
    const shard = path.join(root, "shard");
    await setupShard(shard, "q-bundle", 0);
    const manifestPath = path.join(
      shard, "public", "2026-05-14T100000Z-abc1234",
      "longmemeval-evidence-manifest.json"
    );
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      bundle_sha256: string;
    };
    await writeFile(manifestPath, JSON.stringify({
      ...manifest,
      bundle_sha256: "0".repeat(64)
    }));
    const spool = await LongMemEvalDiagnosticsSpool.create();
    try {
      await expect(loadMergeShards([shard], spool)).rejects.toThrow(
        /bundle sha256 mismatch/u
      );
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
      ...manifest.run,
      candidate_pool_complete: false,
      provenance_complete: false
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
      dataset_sha256: "e".repeat(64)
    }));
    const spool = await LongMemEvalDiagnosticsSpool.create();
    try {
      await expect(loadMergeShards([shard], spool)).rejects.toThrow(/dataset binding/u);
    } finally {
      await spool.dispose();
    }
  });
});
