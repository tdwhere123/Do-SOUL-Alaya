import { gunzipSync } from "node:zlib";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildQuestionDiagnostic } from
  "../../../bench/diagnostics/diagnostics-question.js";
import { readRecallDiagnostics } from
  "../../../bench/diagnostics/schema/diagnostics-private.js";
import { LongMemEvalQuestionDiagnosticSchema } from
  "../../../bench/diagnostics/schema/diagnostics-schema.js";
import type { RecallEvalQuestionResult } from
  "../../../bench/lifecycle/recall-eval/recall-eval-contract.js";
import {
  normalizeRecallEvalDiagnosticsQuestion
} from "../../../bench/provenance/recall-eval/recall-eval-diagnostics.js";
import { RecallEvalDiagnosticsSpool } from
  "../../../bench/provenance/recall-eval/recall-eval-diagnostics-spool.js";
import {
  capturedTruncatedProof,
  provenanceMap,
  unavailableOsfRow
} from "../../harness/recall/capture-proof-diagnostics-fixture.js";
import {
  emptyTokenMetrics,
  promotionMeasurementDiagnostic
} from "../recall-eval/specialized-answerable-recall-fixture.js";

const roots: string[] = [];
const disabledRuntime = {
  embeddingSupplement: { enabled: false } as const,
  answerRerank: { enabled: false } as const
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

describe("capture-proof question diagnostic archive", () => {
  it("preserves both siblings from raw recall through gzip", async () => {
    const lexical_bound_proofs = [capturedTruncatedProof()];
    const candidate_proposition_provenance = provenanceMap();
    const recallResult = {
      diagnostics: { lexical_bound_proofs, candidate_proposition_provenance }
    };
    const narrowed = readRecallDiagnostics(recallResult, "disabled");
    const assembled = assembleQuestion(recallResult);
    const normalized = normalizeRecallEvalDiagnosticsQuestion(
      spoolQuestion(assembled)
    );

    expect(narrowed).not.toBeNull();
    expect({
      read: {
        lexical_bound_proofs: narrowed?.lexicalBoundProofs,
        candidate_proposition_provenance: narrowed?.candidatePropositionProvenance
      },
      assembled: {
        lexical_bound_proofs: assembled.lexical_bound_proofs,
        candidate_proposition_provenance: assembled.candidate_proposition_provenance
      },
      normalized: {
        lexical_bound_proofs: normalized.diagnostics.lexical_bound_proofs,
        candidate_proposition_provenance:
          normalized.diagnostics.candidate_proposition_provenance
      }
    }).toEqual({
      read: { lexical_bound_proofs, candidate_proposition_provenance },
      assembled: { lexical_bound_proofs, candidate_proposition_provenance },
      normalized: { lexical_bound_proofs, candidate_proposition_provenance }
    });

    const archived = await gzipDiagnostics(assembled);
    expect(archived).toContain("lexical_bound_proofs");
    expect(archived).toContain("candidate_proposition_provenance");
    const parsed = LongMemEvalQuestionDiagnosticSchema.parse(
      JSON.parse(archived).questions[0]?.diagnostics
    );
    expect(parsed.lexical_bound_proofs).toEqual(lexical_bound_proofs);
    expect(parsed.candidate_proposition_provenance)
      .toEqual(candidate_proposition_provenance);
  });

  it("fails closed when a present sibling is invalid", () => {
    const invalidProofs = readRecallDiagnostics({
      diagnostics: { lexical_bound_proofs: [] }
    }, "disabled");
    const invalidProvenance = readRecallDiagnostics({
      diagnostics: {
        candidate_proposition_provenance: {
          "other-key": unavailableOsfRow("cand-ineligible", {
            reason: "certified_osf_receipt_absent",
            formation_status: "unavailable",
            composition_status: "unavailable"
          })
        }
      }
    }, "disabled");
    const assembled = assembleQuestion({
      diagnostics: { lexical_bound_proofs: [] }
    });

    expect(invalidProofs).toBeNull();
    expect(invalidProvenance).toBeNull();
    expect(assembled.recall_diagnostics_present).toBe(false);
    expect(assembled.lexical_bound_proofs).toBeNull();
    expect(assembled.candidate_proposition_provenance).toBeNull();
    expect(() => LongMemEvalQuestionDiagnosticSchema.parse({
      ...promotionMeasurementDiagnostic("q-invalid", "scorable", true),
      lexical_bound_proofs: []
    })).toThrow();
  });

  it("parses older artifacts that omit both siblings", () => {
    const assembled = assembleQuestion({ diagnostics: { candidates: [] } });
    const legacy = LongMemEvalQuestionDiagnosticSchema.parse(
      promotionMeasurementDiagnostic("q-legacy", "scorable", true)
    );

    expect(assembled.lexical_bound_proofs).toBeNull();
    expect(assembled.candidate_proposition_provenance).toBeNull();
    expect(readRecallDiagnostics({
      diagnostics: { candidate_proposition_provenance: {} }
    }, "disabled")?.candidatePropositionProvenance).toEqual({});
    expect(legacy.lexical_bound_proofs).toBeUndefined();
    expect(legacy.candidate_proposition_provenance).toBeUndefined();
    expect(JSON.stringify(legacy)).not.toContain("lexical_bound_proofs");
    expect(JSON.stringify(legacy)).not.toContain("candidate_proposition_provenance");
  });
});

function assembleQuestion(recallResult: unknown) {
  return buildQuestionDiagnostic({
    questionId: "q-capture-proof",
    goldMemoryIds: [],
    answerSessionIds: [],
    deliveredResults: [],
    hitAt1: false,
    hitAt5: false,
    hitAt10: false,
    degradationReason: null,
    recallResult,
    embeddingMode: "disabled"
  });
}

function spoolQuestion(
  diagnostics: ReturnType<typeof buildQuestionDiagnostic>
): RecallEvalQuestionResult {
  return {
    questionId: diagnostics.question_id,
    hitAt1: diagnostics.hit_at_1,
    hitAt5: diagnostics.hit_at_5,
    hitAt10: diagnostics.hit_at_10,
    firstTier: "hot",
    latencyMs: 12,
    degradationReason: null,
    diagnostics: {
      ...diagnostics,
      answer_rerank_status: diagnostics.answer_rerank_status ?? "not_requested"
    },
    tokenMetrics: emptyTokenMetrics(),
    recallTokenEconomy: null,
    edgeProposalKpiRows: [],
    embeddingWarmup: null,
    queryEmbeddingWarmup: null,
    documentEmbeddingWarmupLatencyMs: null,
    deliveredObjectIds: []
  };
}

async function gzipDiagnostics(
  diagnostics: ReturnType<typeof buildQuestionDiagnostic>
): Promise<string> {
  const outputRoot = await mkdtemp(join(tmpdir(), "capture-proof-gzip-"));
  roots.push(outputRoot);
  const spool = await RecallEvalDiagnosticsSpool.create();
  const row = spoolQuestion(diagnostics);
  const retained = [await spool.append(row)];
  const artifactPath = join(outputRoot, "recall-eval-diagnostics.json.gz");
  await spool.writeGzipArtifact(artifactPath, {
    retainedQuestions: retained,
    ...disabledRuntime
  });
  await spool.dispose();
  return gunzipSync(await readFile(artifactPath)).toString("utf8");
}
