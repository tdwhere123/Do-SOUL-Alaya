import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { KpiPayloadSchema } from "@do-soul/alaya-eval";
import {
  materializeShardPayload,
  readShardPayloadPlan
} from "../../cli/merge/shard-diagnostics-reader.js";
import { verifyShardEvidenceBundle } from
  "../../cli/merge/shard-evidence-verifier.js";
import { LongMemEvalDiagnosticsSpool } from "../../longmemeval/diagnostics/spool.js";
import {
  buildLongMemEvalEvidenceManifest,
  renderLongMemEvalEvidenceManifest,
  type LongMemEvalEvidenceManifest
} from "../../longmemeval/evidence-manifest.js";
import { buildMergedRunProvenanceSidecars } from
  "../../longmemeval/provenance/shard-aggregate.js";
import {
  LongMemEvalRunProvenanceSchema,
  renderLongMemEvalRunProvenance
} from "../../longmemeval/provenance/run.js";
import { syntheticExtractionClosure } from
  "../longmemeval/extraction-closure-fixture.js";
import { writeMergedLongMemEvalArchive } from "../../cli/merge-command-archive.js";
import {
  buildMergedLongMemEvalPayload,
  loadMergeShards
} from "../../cli/merge-command-shards.js";
import { makeShardDiagnostics } from "./cli-merge-validations-fixture.js";
import {
  candidate,
  cleanupRoots,
  provenance,
  roots,
  setupCompactShard,
  setupShard,
  streamedQuestion
} from "./cli-merge-evidence-fixture.js";

afterEach(cleanupRoots);

describe("verified shard evidence descriptor binding", () => {
  it("accepts a full 500Q-scale run provenance without widening other bindings", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "merge-large-provenance-"));
    roots.push(root);
    const shard = path.join(root, "shard");
    await setupShard(shard, "q-large", 0);
    const slug = "2026-05-14T100000Z-abc1234";
    const entry = path.join(shard, "public", slug);
    const base = provenance(0, 1, ["q-large"]);
    const requestProfile = base.extraction_cache.request_profile;
    if (requestProfile !== "provider-default-v1" &&
        requestProfile !== "deepseek-v4-nonthinking-v1") {
      throw new Error("fixture request profile is invalid");
    }
    const closure = syntheticExtractionClosure({
      count: 96_084,
      model: base.extraction_cache.extraction_model,
      requestProfile,
      seed: "merge-500q"
    });
    const current = LongMemEvalRunProvenanceSchema.parse({
      ...base,
      extraction_cache: {
        ...base.extraction_cache,
        requested_turns: closure.expected_turns,
        cached_turns: closure.expected_turns,
        ...closure
      }
    });
    const contents = renderLongMemEvalRunProvenance(current);
    expect(Buffer.byteLength(contents)).toBeGreaterThan(16 * 1024 * 1024);
    expect(Buffer.byteLength(contents)).toBeLessThan(32 * 1024 * 1024);
    await writeFile(path.join(entry, "longmemeval-run-provenance.json"), contents);
    await rebindRunProvenanceArtifact(entry, contents);
    const payload = KpiPayloadSchema.parse(JSON.parse(
      await readFile(path.join(entry, "kpi.json"), "utf8")
    ));

    await expect(verifyShardEvidenceBundle({ shardRoot: shard, slug, payload }))
      .resolves.toEqual(expect.objectContaining({
        runProvenance: expect.objectContaining({ parsed: current })
      }));
  }, 30_000);

  it("rejects a same-inode binding rewrite after the verifier snapshot", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "merge-binding-snapshot-"));
    roots.push(root);
    const shard = path.join(root, "shard");
    await setupShard(shard, "q-binding", 0);
    const slug = "2026-05-14T100000Z-abc1234";
    const entry = path.join(shard, "public", slug);
    const kpiPath = path.join(entry, "kpi.json");
    const manifestPath = path.join(entry, "longmemeval-evidence-manifest.json");
    const kpiContents = await readFile(kpiPath, "utf8");
    const payload = JSON.parse(kpiContents) as Parameters<
      typeof verifyShardEvidenceBundle
    >[0]["payload"];
    const changedContents = `${JSON.stringify({
      ...payload,
      kpi: { ...payload.kpi, r_at_5: 0 }
    }, null, 2)}\n`;
    const current = JSON.parse(await readFile(manifestPath, "utf8")) as
      LongMemEvalEvidenceManifest;
    const rebuilt = buildLongMemEvalEvidenceManifest({
      run: current.run,
      artifacts: current.artifacts.map((artifact) => artifact.role === "kpi"
        ? { role: artifact.role, path: artifact.path, contents: changedContents }
        : {
            role: artifact.role,
            path: artifact.path,
            identity: { sha256: artifact.sha256, bytes: artifact.bytes }
          })
    });
    await writeFile(manifestPath, renderLongMemEvalEvidenceManifest(rebuilt));
    const inode = (await stat(kpiPath)).ino;
    let rewroteBinding = false;

    await expect(verifyShardEvidenceBundle({ shardRoot: shard, slug, payload }, {
      afterBindingArtifactSnapshot: async (artifactPath) => {
        if (artifactPath !== "kpi.json") return;
        rewroteBinding = true;
        await writeFile(kpiPath, changedContents);
      }
    })).rejects.toThrow(/sha256 mismatch: kpi\.json/u);

    expect(rewroteBinding).toBe(true);
    expect((await stat(kpiPath)).ino).toBe(inode);
  });

  it("materializes the verified compact sidecar captured by the plan", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "merge-compact-plan-binding-"));
    roots.push(root);
    const shard = path.join(root, "shard");
    await setupCompactShard(shard, "q-compact", 0);
    const plan = await readShardPayloadPlan(shard);
    await writeFile(
      path.join(shard, "public", plan.slug, "longmemeval-diagnostics.json"),
      `${JSON.stringify(makeShardDiagnostics({ question_count: 99 }), null, 2)}\n`
    );
    const spool = await LongMemEvalDiagnosticsSpool.create();
    try {
      const materialized = await materializeShardPayload(plan, spool);
      expect(materialized.diagnostics.questions).toHaveLength(1);
    } finally {
      await spool.dispose();
    }
  });

  it("rejects a full diagnostics artifact replaced after verification", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "merge-full-plan-binding-"));
    roots.push(root);
    const shard = path.join(root, "shard");
    await setupCompactShard(shard, "q-full", 0);
    const plan = await readShardPayloadPlan(shard);
    await writeFile(
      path.join(shard, "public", plan.slug, "longmemeval-diagnostics.json.gz"),
      gzipSync(`${JSON.stringify(makeShardDiagnostics({
        questions: [{
          ...streamedQuestion("q-full"),
          recall_diagnostics_keys: ["replacement"]
        }]
      }))}\n`)
    );
    const spool = await LongMemEvalDiagnosticsSpool.create();
    try {
      await expect(materializeShardPayload(plan, spool)).rejects.toThrow(
        /full diagnostics artifact identity mismatch/u
      );
    } finally {
      await spool.dispose();
    }
  });

  it("publishes verified child provenance bytes captured before path replacement", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "merge-provenance-plan-binding-"));
    roots.push(root);
    const shard = path.join(root, "shard");
    await setupShard(shard, "q-provenance", 0);
    const spool = await LongMemEvalDiagnosticsSpool.create();
    try {
      const loaded = await loadMergeShards([shard], spool);
      const build = buildMergedLongMemEvalPayload(loaded);
      const drifted = provenance(0, 1, ["q-provenance"]);
      await writeFile(
        path.join(shard, "public", loaded.archiveRefs[0]!.slug, "longmemeval-run-provenance.json"),
        `${JSON.stringify({
          ...drifted,
          code: {
            ...drifted.code,
            executed_dist: { ...drifted.code.executed_dist, sha256: "9".repeat(64) }
          }
        }, null, 2)}\n`
      );
      const sidecars = await buildMergedRunProvenanceSidecars({
        shardArchiveRefs: loaded.archiveRefs,
        selectionContract: build.selectionContract
      });
      const child = sidecars.sidecars.find((item) => item.filename.includes("shard-0"));
      expect(child?.contents).toContain(`"sha256": "${"f".repeat(64)}"`);
      expect(child?.contents).not.toContain(`"sha256": "${"9".repeat(64)}"`);
    } finally {
      await spool.dispose();
    }
  });

  it("projects one captured selection contract into every archive consumer", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "merge-selection-plan-binding-"));
    roots.push(root);
    const shardA = path.join(root, "a");
    const shardB = path.join(root, "b");
    await setupShard(shardA, "q-a", 0);
    await setupShard(shardB, "q-b", 1);
    const spool = await LongMemEvalDiagnosticsSpool.create();
    try {
      const loaded = await loadMergeShards([shardA, shardB], spool);
      const build = buildMergedLongMemEvalPayload(loaded);
      const expected = build.payload.selection_contract;
      const firstAssignment = loaded.archiveRefs[0]!.verifiedEvidence!.assignments[0] as {
        question_id: string;
      };
      firstAssignment.question_id = "path-mutated-after-plan";

      const written = await writeMergedLongMemEvalArchive({
        historyRoot: path.join(root, "history"),
        build,
        shardArchiveRefs: loaded.archiveRefs,
        diagnosticsSpool: spool
      });

      expect(written.merged.selection_contract).toEqual(expected);
    } finally {
      await spool.dispose();
    }
  });

  it("rejects a same-ID candidate spool rewrite before archive publication", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "merge-spool-binding-"));
    roots.push(root);
    const shard = path.join(root, "shard");
    const history = path.join(root, "history");
    await setupShard(shard, "q-spool", 0);
    const spool = await LongMemEvalDiagnosticsSpool.create();
    try {
      const loaded = await loadMergeShards([shard], spool);
      const build = buildMergedLongMemEvalPayload(loaded);
      const spoolPath = path.join(spool.rootPath, "questions.ndjson");
      const original = JSON.parse((await readFile(spoolPath, "utf8")).trim()) as {
        readonly question_id: string;
      };
      const inode = (await stat(spoolPath)).ino;
      await writeFile(spoolPath, `${JSON.stringify({
        ...original,
        candidates: [candidate()]
      })}\n`);
      expect((await stat(spoolPath)).ino).toBe(inode);

      await expect(writeMergedLongMemEvalArchive({
        historyRoot: history,
        build,
        shardArchiveRefs: loaded.archiveRefs,
        diagnosticsSpool: spool
      })).rejects.toThrow(/diagnostics spool sealed identity mismatch/u);
      expect(await publicHistoryEntries(history)).toEqual([]);
    } finally {
      await spool.dispose();
    }
  });
});

async function rebindRunProvenanceArtifact(
  entryRoot: string,
  contents: string
): Promise<void> {
  const manifestPath = path.join(entryRoot, "longmemeval-evidence-manifest.json");
  const current = JSON.parse(await readFile(manifestPath, "utf8")) as
    LongMemEvalEvidenceManifest;
  const rebuilt = buildLongMemEvalEvidenceManifest({
    run: current.run,
    artifacts: current.artifacts.map((artifact) => artifact.role === "run_provenance"
      ? { role: artifact.role, path: artifact.path, contents }
      : {
          role: artifact.role,
          path: artifact.path,
          identity: { sha256: artifact.sha256, bytes: artifact.bytes }
        })
  });
  await writeFile(manifestPath, renderLongMemEvalEvidenceManifest(rebuilt));
}

async function publicHistoryEntries(historyRoot: string): Promise<readonly string[]> {
  try {
    return await readdir(path.join(historyRoot, "public"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
