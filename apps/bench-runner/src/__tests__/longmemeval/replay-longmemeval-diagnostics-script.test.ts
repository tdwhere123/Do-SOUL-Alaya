import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(__dirname, "../../../../..");

async function writeReplayDiagnostics(questions: readonly unknown[]): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "alaya-replay-script-"));
  const diagnosticsPath = path.join(dir, "longmemeval-diagnostics.json");
  await writeFile(
    diagnosticsPath,
    JSON.stringify({ schema_version: 1, questions }, null, 2),
    "utf8"
  );
  return diagnosticsPath;
}

function candidate(
  objectId: string,
  input: {
    readonly facetOverlap?: number;
    readonly activation?: number;
    readonly createdAt?: string;
    readonly streams?: Readonly<Record<string, number>>;
    readonly ranks?: Readonly<Record<string, number | null>>;
  } = {}
): unknown {
  return {
    object_id: objectId,
    fused_rank_contribution_per_stream: input.streams ?? { lexical_fts: 0 },
    ...(input.ranks === undefined ? {} : { per_stream_rank: input.ranks }),
    score_factors: {
      facet_overlap: input.facetOverlap ?? 0,
      activation: input.activation ?? 0,
      created_at: input.createdAt ?? "2026-07-07T00:00:00.000Z"
    }
  };
}

describe("replay-longmemeval-diagnostics script", () => {
  it("reports weighted A/B metrics with legacy facet-overlap-first ordering when requested", async () => {
    const diagnosticsPath = await writeReplayDiagnostics([
      {
        question_id: "q-one",
        candidate_pool_complete: true,
        gold: [
          { object_id: "gold-a", final_rank: 1 },
          { object_id: "gold-b", final_rank: null }
        ],
        candidates: [
          candidate("gold-a", { facetOverlap: 2, streams: { lexical_fts: 0.01 } }),
          candidate("d1", { facetOverlap: 1, streams: { lexical_fts: 0.9 } }),
          candidate("d2", { facetOverlap: 1, streams: { lexical_fts: 0.8 } }),
          candidate("d3", { facetOverlap: 1, streams: { lexical_fts: 0.7 } }),
          candidate("d4", { facetOverlap: 1, streams: { lexical_fts: 0.6 } }),
          candidate("gold-b", { facetOverlap: 0, streams: { lexical_fts: 99 } })
        ]
      },
      {
        question_id: "q-two",
        candidate_pool_complete: true,
        gold: [{ object_id: "gold-c", final_rank: 1 }],
        candidates: [
          candidate("gold-c", { streams: { lexical_fts: 0.5 } }),
          candidate("d5", { streams: { lexical_fts: 0.4 } })
        ]
      }
    ]);

    const { stdout } = await execFileAsync("node", [
      "apps/bench-runner/scripts/replay-longmemeval-diagnostics.mjs",
      "--diagnostics",
      diagnosticsPath,
      "--weights",
      "lexical_fts=1",
      "--facet-order",
      "first"
    ], { cwd: rootDir });

    const report = JSON.parse(stdout);
    expect(report.ab).toMatchObject({
      mode: "weighted_ab",
      gold_bearing_questions: 2,
      any_at_5_count: 2,
      any_at_5: 1,
      full_gold_at_5_count: 1,
      full_gold_at_5: 0.5,
      gold_coverage_at_5_count: 2,
      gold_coverage_at_5: 2 / 3,
      facet_order: "first"
    });
  });

  it("defaults to facet-overlap as a score tie-break to match production fused rank", async () => {
    const diagnosticsPath = await writeReplayDiagnostics([
      {
        question_id: "q-facet-default",
        candidate_pool_complete: true,
        gold: [{ object_id: "gold-score", final_rank: null }],
        candidates: [
          candidate("d1", { facetOverlap: 2, streams: { lexical_fts: 0.01 } }),
          candidate("d2", { facetOverlap: 2, streams: { lexical_fts: 0.01 } }),
          candidate("d3", { facetOverlap: 2, streams: { lexical_fts: 0.01 } }),
          candidate("d4", { facetOverlap: 2, streams: { lexical_fts: 0.01 } }),
          candidate("d5", { facetOverlap: 2, streams: { lexical_fts: 0.01 } }),
          candidate("gold-score", { facetOverlap: 1, streams: { lexical_fts: 99 } })
        ]
      }
    ]);

    const { stdout } = await execFileAsync("node", [
      "apps/bench-runner/scripts/replay-longmemeval-diagnostics.mjs",
      "--diagnostics",
      diagnosticsPath,
      "--weights",
      "lexical_fts=1"
    ], { cwd: rootDir });

    const report = JSON.parse(stdout);
    expect(report.ab).toMatchObject({
      any_at_5_count: 1,
      facet_order: "tie-break"
    });
  });

  it("can demote facet-overlap to a score tie-break for E2 replay", async () => {
    const diagnosticsPath = await writeReplayDiagnostics([
      {
        question_id: "q-facet-order",
        candidate_pool_complete: true,
        gold: [{ object_id: "gold-score", final_rank: null }],
        candidates: [
          candidate("d1", { facetOverlap: 2, streams: { lexical_fts: 0.01 } }),
          candidate("d2", { facetOverlap: 2, streams: { lexical_fts: 0.01 } }),
          candidate("d3", { facetOverlap: 2, streams: { lexical_fts: 0.01 } }),
          candidate("d4", { facetOverlap: 2, streams: { lexical_fts: 0.01 } }),
          candidate("d5", { facetOverlap: 2, streams: { lexical_fts: 0.01 } }),
          candidate("gold-score", { facetOverlap: 1, streams: { lexical_fts: 99 } })
        ]
      }
    ]);

    const { stdout } = await execFileAsync("node", [
      "apps/bench-runner/scripts/replay-longmemeval-diagnostics.mjs",
      "--diagnostics",
      diagnosticsPath,
      "--weights",
      "lexical_fts=1",
      "--facet-order",
      "tie-break"
    ], { cwd: rootDir });

    const report = JSON.parse(stdout);
    expect(report.ab).toMatchObject({
      any_at_5_count: 1,
      facet_order: "tie-break"
    });
  });

  it("rejects unknown facet ordering modes", async () => {
    const diagnosticsPath = await writeReplayDiagnostics([]);

    await expect(
      execFileAsync("node", [
        "apps/bench-runner/scripts/replay-longmemeval-diagnostics.mjs",
        "--diagnostics",
        diagnosticsPath,
        "--weights",
        "lexical_fts=1",
        "--facet-order",
        "off"
      ], { cwd: rootDir })
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("--facet-order must be one of: first, tie-break")
    });
  });

  it("recomputes stream contribution from per-stream rank when --rrf-k is supplied", async () => {
    const diagnosticsPath = await writeReplayDiagnostics([
      {
        question_id: "q-rrf",
        candidate_pool_complete: true,
        gold: [{ object_id: "gold-rank", final_rank: null }],
        candidates: [
          candidate("d1", { streams: { lexical_fts: 100 }, ranks: { lexical_fts: 10 } }),
          candidate("d2", { streams: { lexical_fts: 100 }, ranks: { lexical_fts: 11 } }),
          candidate("d3", { streams: { lexical_fts: 100 }, ranks: { lexical_fts: 12 } }),
          candidate("d4", { streams: { lexical_fts: 100 }, ranks: { lexical_fts: 13 } }),
          candidate("d5", { streams: { lexical_fts: 100 }, ranks: { lexical_fts: 14 } }),
          candidate("d6", { streams: { lexical_fts: 100 }, ranks: { lexical_fts: 15 } }),
          candidate("gold-rank", { streams: { lexical_fts: 0 }, ranks: { lexical_fts: 1 } })
        ]
      }
    ]);

    const { stdout } = await execFileAsync("node", [
      "apps/bench-runner/scripts/replay-longmemeval-diagnostics.mjs",
      "--diagnostics",
      diagnosticsPath,
      "--weights",
      "lexical_fts=1",
      "--rrf-k",
      "60"
    ], { cwd: rootDir });

    const report = JSON.parse(stdout);
    expect(report.ab).toMatchObject({
      any_at_5_count: 1,
      full_gold_at_5_count: 1,
      gold_coverage_at_5_count: 1,
      rrf_k: 60
    });
  });

  it("fails loud when --rrf-k is requested but only frozen contributions are present", async () => {
    const diagnosticsPath = await writeReplayDiagnostics([
      {
        question_id: "q-frozen-only",
        candidate_pool_complete: true,
        gold: [{ object_id: "gold", final_rank: 1 }],
        candidates: [candidate("gold", { streams: { lexical_fts: 1 } })]
      }
    ]);

    await expect(
      execFileAsync("node", [
        "apps/bench-runner/scripts/replay-longmemeval-diagnostics.mjs",
        "--diagnostics",
        diagnosticsPath,
        "--weights",
        "lexical_fts=1",
        "--rrf-k",
        "60"
      ], { cwd: rootDir })
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("requires per_stream_rank")
    });
  });

  it("explicitly refuses candidate-retrieval parameter changes", async () => {
    const diagnosticsPath = await writeReplayDiagnostics([]);

    await expect(
      execFileAsync("node", [
        "apps/bench-runner/scripts/replay-longmemeval-diagnostics.mjs",
        "--diagnostics",
        diagnosticsPath,
        "--candidate-limit",
        "100"
      ], { cwd: rootDir })
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("candidate-retrieval parameter changes are not replayable")
    });
  });
});
