import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LongMemEvalQuestionDiagnosticSchema } from "../../longmemeval/diagnostics-schema.js";
import {
  LongMemEvalDiagnosticsSpool,
  withLongMemEvalDiagnosticsSpool
} from "../../longmemeval/diagnostics/spool.js";
import { readExternalDiagnosticsSidecarArtifact } from "../../longmemeval/diagnostics-artifacts.js";
import type { LongMemEvalDiagnosticsSidecar } from "../../longmemeval/diagnostics.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("LongMemEval diagnostics spool", () => {
  it("retains no candidate pools while streaming a hash-bound full artifact", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "diagnostics-spool-output-"));
    roots.push(outputRoot);
    const spool = await LongMemEvalDiagnosticsSpool.create();
    const retained = [];
    for (let index = 0; index < 200; index += 1) {
      retained.push(await spool.append(question(`q-${index}`, 50)));
    }
    const artifactPath = join(outputRoot, "longmemeval-diagnostics.json.gz");
    const identity = await spool.writeGzipArtifact(
      artifactPath,
      sidecar(retained)
    );

    expect(retained.every((row) => row.candidates.length === 0)).toBe(true);
    expect(retained.every((row) => row.candidate_pool_complete)).toBe(true);
    expect(retained[0]?.query_probes?.normalized_query).toHaveLength(4_096);
    expect(spool.questionCount).toBe(200);
    expect(identity).not.toHaveProperty("contents");
    const bytes = await readFile(artifactPath);
    expect(identity).toEqual({
      artifactPath,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex")
    });
    const parsed = await readExternalDiagnosticsSidecarArtifact(artifactPath);
    expect(parsed.questions).toHaveLength(200);
    expect(parsed.questions[0]?.candidates).toHaveLength(50);
    await spool.dispose();
  });

  it.each(["success", "failure"])("cleans its owned root after %s", async (mode) => {
    let ownedRoot = "";
    const run = withLongMemEvalDiagnosticsSpool(async (spool) => {
      ownedRoot = spool.rootPath;
      await spool.append(question("q-cleanup", 1));
      if (mode === "failure") throw new Error("synthetic failure");
      return "done";
    });
    if (mode === "failure") await expect(run).rejects.toThrow("synthetic failure");
    else await expect(run).resolves.toBe("done");
    await expect(access(ownedRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function sidecar(
  questions: LongMemEvalDiagnosticsSidecar["questions"]
): LongMemEvalDiagnosticsSidecar {
  return {
    schema_version: 1,
    bench_name: "public",
    split: "longmemeval_s",
    run_at: "2026-07-11T00:00:00.000Z",
    alaya_commit: "deadbee",
    embedding_provider: "local_onnx",
    embedding_mode: "env",
    questions
  } as LongMemEvalDiagnosticsSidecar;
}

function question(id: string, candidateCount: number) {
  const candidate = {
    object_id: "object-a",
    candidate_key: "workspace_local:memory_entry:object-a",
    final_rank: 1,
    pre_budget_rank: 1,
    selection_order: 1,
    fused_rank: 1,
    fused_score: 1,
    per_stream_rank: null,
    fused_rank_contribution_per_stream: null,
    score_factors: {}
  };
  return LongMemEvalQuestionDiagnosticSchema.parse({
    question_id: id,
    question_type: "synthetic",
    is_abstention: false,
    premise_invalid: false,
    round_index: null,
    gold_memory_ids: [],
    answer_session_ids: [],
    delivered_results: [],
    active_constraint_results: [],
    hit_at_1: true,
    hit_at_5: true,
    hit_at_10: true,
    miss_classification: "hit_at_5",
    degradation_reason: null,
    recall_diagnostics_present: true,
    recall_diagnostics_keys: [],
    provider_state: "provider_returned",
    provider_degradation_reason: null,
    graph_expansion_plane_count_per_hop: [0, 0],
    graph_expansion_plane_count_per_edge_type: {
      derives_from: 0,
      recalls: 0,
      supports: 0
    },
    candidate_pool_complete: true,
    query_probes: { normalized_query: "x".repeat(4_096) },
    candidates: Array.from({ length: candidateCount }, () => candidate),
    candidate_key_collisions: [],
    gold: []
  });
}
