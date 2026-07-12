import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  readExternalDiagnosticsArtifact,
  readExternalDiagnosticsSidecarArtifact,
  streamExternalDiagnosticsQuestions,
  writeExternalDiagnosticsArtifact,
  writeExternalGzipDiagnosticsArtifact,
  writeExternalGzipDiagnosticsSidecarArtifact
} from "../../longmemeval/diagnostics-artifacts.js";
import { LongMemEvalQuestionDiagnosticSchema } from "../../longmemeval/diagnostics-schema.js";
import {
  renderDiagnosticsSidecar,
  type LongMemEvalDiagnosticsSidecar
} from "../../longmemeval/diagnostics.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function artifactRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "alaya-diagnostics-artifact-"));
  roots.push(root);
  return root;
}

describe("LongMemEval diagnostics artifacts", () => {
  it("returns a streamed identity without returning gzip contents", async () => {
    const historyRoot = await artifactRoot();
    const repeatedQuestion = {
      ...validQuestionDiagnostic(),
      question_id: "q-large",
      query_probes: { normalized_query: `large é 🌍 ${"x".repeat(4 * 1024)}` }
    };
    const questions = Array.from({ length: 200 }, () => repeatedQuestion);
    const sidecar = {
      schema_version: 1,
      questions
    } as unknown as LongMemEvalDiagnosticsSidecar;
    Object.defineProperty(sidecar, "toJSON", {
      value: () => {
        throw new Error("whole-sidecar JSON.stringify is forbidden");
      }
    });

    const written = await writeExternalGzipDiagnosticsSidecarArtifact({
      historyRoot,
      benchName: "public",
      slug: "large",
      filename: "longmemeval-diagnostics.json.gz",
      sidecar
    });

    const bytes = await readFile(written.artifactPath);
    expect(written).not.toHaveProperty("contents");
    expect(written.bytes).toBe(bytes.byteLength);
    expect(written.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    const parsed = await readExternalDiagnosticsSidecarArtifact(
      written.artifactPath
    );
    expect(parsed.questions).toHaveLength(questions.length);
    expect(parsed.questions[0]?.query_probes?.normalized_query)
      .toBe(repeatedQuestion.query_probes.normalized_query);
  });

  it("roundtrips streamed diagnostics without schema or JSON drift", async () => {
    const historyRoot = await artifactRoot();
    const question = validQuestionDiagnostic();
    const sidecar = validDiagnosticsSidecar(question);
    const written = await writeExternalGzipDiagnosticsSidecarArtifact({
      historyRoot,
      benchName: "public",
      slug: "schema",
      filename: "longmemeval-diagnostics.json.gz",
      sidecar
    });
    const repeated = await writeExternalGzipDiagnosticsSidecarArtifact({
      historyRoot,
      benchName: "public",
      slug: "schema-repeat",
      filename: "longmemeval-diagnostics.json.gz",
      sidecar
    });

    const parsed = await readExternalDiagnosticsSidecarArtifact(
      written.artifactPath
    );
    expect(LongMemEvalQuestionDiagnosticSchema.parse(parsed.questions[0])).toEqual(question);
    expect(parsed).toEqual(JSON.parse(renderDiagnosticsSidecar(sidecar)));
    expect(written.sha256).toBe(repeated.sha256);
    expect(written.bytes).toBe(repeated.bytes);
  });

  it("writes deterministic gzip bytes that roundtrip and materially compress repeated evidence", async () => {
    const historyRoot = await artifactRoot();
    const contents = `${JSON.stringify({
      questions: Array.from({ length: 500 }, (_, index) => ({
        question_id: `q-${index}`,
        candidates: Array.from({ length: 50 }, () => ({
          content: "repeated candidate evidence ".repeat(20),
          rank: 1
        }))
      }))
    })}\n`;
    const first = await writeExternalGzipDiagnosticsArtifact({
      historyRoot,
      benchName: "public",
      slug: "run-a",
      filename: "longmemeval-diagnostics.json.gz",
      contents
    });
    const second = await writeExternalGzipDiagnosticsArtifact({
      historyRoot,
      benchName: "public",
      slug: "run-b",
      filename: "longmemeval-diagnostics.json.gz",
      contents
    });

    expect(first.bytes).toEqual(second.bytes);
    expect(first.bytes.byteLength).toBeLessThan(Buffer.byteLength(contents) / 10);
    expect(await readFile(first.artifactPath)).toEqual(first.bytes);
    await expect(readExternalDiagnosticsArtifact(first.artifactPath)).resolves.toBe(contents);
  });

  it("keeps legacy plain JSON readable", async () => {
    const historyRoot = await artifactRoot();
    const contents = "{\"schema_version\":1}\n";
    const artifactPath = await writeExternalDiagnosticsArtifact({
      historyRoot,
      benchName: "public",
      slug: "legacy",
      filename: "longmemeval-diagnostics.json",
      contents
    });

    await expect(readExternalDiagnosticsArtifact(artifactPath)).resolves.toBe(contents);
  });

  it("streams a production-sized plain JSON artifact question by question", async () => {
    const historyRoot = await artifactRoot();
    const artifactPath = path.join(historyRoot, "plain-production.json");
    const question = {
      ...validQuestionDiagnostic(),
      query_probes: { normalized_query: "x".repeat(32 * 1024) }
    };
    const sidecar = validDiagnosticsSidecar(question);
    await writeFile(artifactPath, JSON.stringify({
      ...sidecar,
      questions: Array.from({ length: 320 }, (_, index) => ({
        ...question,
        question_id: `plain-${index}`
      }))
    }));

    let count = 0;
    for await (const row of streamExternalDiagnosticsQuestions(artifactPath)) {
      expect(row.question_id).toBe(`plain-${count}`);
      count += 1;
    }
    expect(count).toBe(320);
  });

  it("fails loudly when a gzip artifact is corrupt", async () => {
    const historyRoot = await artifactRoot();
    const artifactPath = path.join(historyRoot, "corrupt.json.gz");
    await writeFile(artifactPath, Buffer.from("not gzip bytes"));

    await expect(readExternalDiagnosticsArtifact(artifactPath)).rejects.toThrow();
  });

  it.each(["plain", "gzip"])("rejects invalid UTF-8 in %s diagnostics", async (kind) => {
    const historyRoot = await artifactRoot();
    const artifactPath = path.join(historyRoot, `invalid-utf8.json${kind === "gzip" ? ".gz" : ""}`);
    const document = Buffer.from(JSON.stringify(validDiagnosticsSidecar({
      ...validQuestionDiagnostic(),
      query_probes: { normalized_query: "INVALID_UTF8_MARKER" }
    })));
    const marker = Buffer.from("INVALID_UTF8_MARKER");
    const offset = document.indexOf(marker);
    const invalid = Buffer.concat([
      document.subarray(0, offset),
      Buffer.from([0xc3, 0x28]),
      document.subarray(offset + marker.byteLength)
    ]);
    await writeFile(artifactPath, kind === "gzip" ? gzipSync(invalid) : invalid);

    await expect(readExternalDiagnosticsSidecarArtifact(artifactPath))
      .rejects.toThrow(/invalid UTF-8/u);
  });

  it("preserves ENOENT for compact-sidecar fallback", async () => {
    const historyRoot = await artifactRoot();

    await expect(readExternalDiagnosticsSidecarArtifact(
      path.join(historyRoot, "missing.json.gz")
    )).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["truncated", '{"schema_version":1,"questions":[{"question_id":"q"'],
    ["trailing garbage", `${JSON.stringify(validDiagnosticsSidecar(validQuestionDiagnostic()))} nope`],
    ["invalid question schema", '{"schema_version":1,"questions":[{"question_id":4}]}']
  ])("fails loudly for %s streamed diagnostics", async (_label, contents) => {
    const historyRoot = await artifactRoot();
    const artifactPath = path.join(historyRoot, "invalid.json.gz");
    await writeFile(artifactPath, gzipSync(contents));

    await expect(readExternalDiagnosticsSidecarArtifact(artifactPath))
      .rejects.toThrow(/diagnostics|schema|trailing|truncated/iu);
  });

  it("fails before retaining a single oversized question", async () => {
    const historyRoot = await artifactRoot();
    const artifactPath = path.join(historyRoot, "oversized.json.gz");
    const contents = JSON.stringify(validDiagnosticsSidecar({
      ...validQuestionDiagnostic(),
      query_probes: { normalized_query: "escaped \\\" } ] 🌍" }
    }));
    await writeFile(artifactPath, gzipSync(contents));

    await expect(readExternalDiagnosticsSidecarArtifact(artifactPath, {
      maxQuestionChars: 64
    })).rejects.toThrow(/question exceeds 64 characters/u);
  });

  it("fails loudly when a streamed gzip artifact cannot be written", async () => {
    const historyRoot = await artifactRoot();
    const blockedRoot = path.join(historyRoot, "blocked");
    await writeFile(blockedRoot, "not a directory", "utf8");
    const previous = process.env.ALAYA_BENCH_ARTIFACT_ROOT;
    process.env.ALAYA_BENCH_ARTIFACT_ROOT = blockedRoot;
    try {
      await expect(writeExternalGzipDiagnosticsSidecarArtifact({
        historyRoot,
        benchName: "public",
        slug: "write-failure",
        filename: "longmemeval-diagnostics.json.gz",
        sidecar: validDiagnosticsSidecar(validQuestionDiagnostic())
      })).rejects.toThrow();
    } finally {
      if (previous === undefined) delete process.env.ALAYA_BENCH_ARTIFACT_ROOT;
      else process.env.ALAYA_BENCH_ARTIFACT_ROOT = previous;
    }
  });
});

function validDiagnosticsSidecar(
  question: ReturnType<typeof validQuestionDiagnostic>
): LongMemEvalDiagnosticsSidecar {
  return {
    schema_version: 1,
    bench_name: "public",
    split: "longmemeval_s",
    run_at: "2026-07-11T00:00:00.000Z",
    alaya_commit: "deadbee",
    embedding_provider: "local_onnx",
    embedding_mode: "env",
    provider_state_summary: {
      total: 1,
      provider_returned: 1,
      provider_pending: 0,
      provider_failed: 0,
      provider_not_requested: 0,
      unknown: 0,
      provider_returned_rate: 1,
      provider_pending_rate: 0,
      provider_failed_rate: 0,
      provider_not_requested_rate: 0,
      unknown_rate: 0
    },
    questions: [question]
  };
}

function validQuestionDiagnostic() {
  return LongMemEvalQuestionDiagnosticSchema.parse({
    question_id: "q-schema",
    question_type: "single-session-user",
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
    miss_taxonomy: null,
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
    query_sought_facets: null,
    candidates: [],
    candidate_key_collisions: [],
    gold: []
  });
}
