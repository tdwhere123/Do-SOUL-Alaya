import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../../cli/index.js";
import { loadMergeShards } from "../../cli/merge-command-shards.js";
import { LongMemEvalDiagnosticsSpool } from "../../longmemeval/diagnostics/spool.js";
import { buildQuestionDiagnosticFixture } from "../longmemeval/gold-diagnostic-fixture.js";
import {
  LONGMEMEVAL_DIAGNOSTICS_FILENAME,
  makeShardDiagnostics,
  makeShardKpi,
  writeShardRoot
} from "./cli-merge-validations-fixture.js";

let root: string | null = null;

afterEach(async () => {
  if (root !== null) await rm(root, { recursive: true, force: true });
  root = null;
});

describe("merge-longmemeval compact diagnostics", () => {
  it("reads legacy full artifacts without retaining candidate pools", async () => {
    root = await mkdtemp(path.join(tmpdir(), "merge-compact-"));
    const rowsA = rows("q-compact");
    const rowsB = rows("q-missing-side-effects");
    const shardA = path.join(root, "a");
    const shardB = path.join(root, "b");
    const artifactA = await writeLegacyArtifact(shardA, rowsA);
    const artifactB = await writeLegacyArtifact(shardB, rowsB);
    const fullSideEffects = makeShardDiagnostics().report_side_effects as
      Record<string, unknown>;
    const compactSideEffects = {
      ...Object.fromEntries(
        Object.entries(fullSideEffects).filter(([key]) => key !== "snapshots")
      ),
      snapshot_count: 5
    };
    await writeCompactShard(
      shardA,
      rowsA,
      artifactA,
      compactSideEffects
    );
    await writeCompactShard(shardB, rowsB, artifactB);

    const historyRoot = path.join(root, "history");
    expect(await runCli([
      "merge-longmemeval", "--variant", "s", "--history-root", historyRoot,
      "--shards", shardA, shardB
    ])).toBe(0);

    const diagnostics = await readMergedDiagnostics(historyRoot);
    expect(diagnostics.question_count).toBe(10);
    expect(diagnostics.questions).toHaveLength(10);
    expect(diagnostics.questions.every((question) =>
      question.candidates.length === 0
    )).toBe(true);
    expect(diagnostics.report_side_effects).toMatchObject({
      memory_graph_edges_total: 2,
      recalls_edge_count: 2,
      path_relations_total: 0,
      snapshot_count: 5
    });
  });

  it("rejects a safe-looking artifact path through a symlinked ancestor", async () => {
    root = await mkdtemp(path.join(tmpdir(), "merge-compact-symlink-"));
    const shard = path.join(root, "shard");
    const outside = path.join(root, "outside");
    const rowsOne = rows("q-symlink").slice(0, 1);
    const reference = path.posix.join(
      "public", "2026-05-14T100000Z-abc1234", "full.json"
    );
    await mkdir(path.join(outside, "2026-05-14T100000Z-abc1234"), { recursive: true });
    await writeFile(path.join(outside, "2026-05-14T100000Z-abc1234", "full.json"),
      JSON.stringify(makeShardDiagnostics({
        questions: rowsOne.map((row) => buildQuestionDiagnosticFixture({
          questionId: row.id, gold: []
        }))
      }))
    );
    await mkdir(path.join(shard, ".bench-artifacts"), { recursive: true });
    await symlink(outside, path.join(shard, ".bench-artifacts", "public"), "dir");
    await writeCompactShard(shard, rowsOne, reference);

    const spool = await LongMemEvalDiagnosticsSpool.create();
    try {
      await expect(loadMergeShards([shard], spool)).rejects.toThrow(
        /resolves outside declared root/u
      );
    } finally {
      await spool.dispose();
    }
  });
});

function rows(prefix: string) {
  return Array.from({ length: 5 }, (_, index) => ({
    id: `${prefix}-${index + 1}`,
    version: 1,
    hit_at_5: true,
    tier: "warm" as const
  }));
}

async function writeLegacyArtifact(
  shardRoot: string,
  scenarioRows: ReturnType<typeof rows>
): Promise<string> {
  const reference = path.posix.join(
    "public", "2026-05-14T100000Z-abc1234", "full-diagnostics.json"
  );
  const artifactPath = path.join(shardRoot, ".bench-artifacts", reference);
  await mkdir(path.dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, JSON.stringify(makeShardDiagnostics({
    questions: scenarioRows.map((row) => buildQuestionDiagnosticFixture({
      questionId: row.id,
      gold: []
    }))
  })));
  return reference;
}

async function writeCompactShard(
  shardRoot: string,
  scenarioRows: ReturnType<typeof rows>,
  artifactPath: string,
  reportSideEffects?: Record<string, unknown>
): Promise<void> {
  await writeShardRoot(shardRoot, makeShardKpi({
    policy_shape: "chat",
    simulate_report: "mixed",
    kpi: {
      ...makeShardKpi().kpi,
      r_at_5: 1,
      per_scenario: scenarioRows
    }
  }), makeShardDiagnostics({
    compact_schema_version: 1,
    question_count: scenarioRows.length,
    full_diagnostics_artifact_path: artifactPath,
    questions: undefined,
    report_side_effects: reportSideEffects
  }));
}

interface MergedDiagnosticsFixture {
  readonly question_count: number;
  readonly questions: readonly { readonly candidates: readonly unknown[] }[];
  readonly report_side_effects?: Record<string, number>;
}

async function readMergedDiagnostics(
  historyRoot: string
): Promise<MergedDiagnosticsFixture> {
  const pointer = JSON.parse(await readFile(
    path.join(historyRoot, "public", "latest-run.json"),
    "utf8"
  )) as { readonly slug: string };
  return JSON.parse(await readFile(path.join(
    historyRoot,
    "public",
    pointer.slug,
    LONGMEMEVAL_DIAGNOSTICS_FILENAME
  ), "utf8")) as MergedDiagnosticsFixture;
}
