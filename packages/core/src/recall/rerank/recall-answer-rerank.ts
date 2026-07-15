import type { FineAssessmentCandidate } from "../delivery/fine-assessment-selection.js";
import type {
  RecallAnswerRerankDiagnostics,
  RecallServiceAnswerRerankPort,
  RecallServiceWarnPort
} from "../runtime/recall-service-types.js";

const ANSWER_RERANK_BATCH_LIMIT = 50;

export async function collectAnswerRelevanceScores(params: Readonly<{
  readonly service: RecallServiceAnswerRerankPort | undefined;
  readonly queryText: string | null;
  readonly candidates: readonly FineAssessmentCandidate[];
  readonly warn: RecallServiceWarnPort;
}>): Promise<Readonly<{
  readonly scores: ReadonlyMap<string, number>;
  readonly diagnostics: Readonly<RecallAnswerRerankDiagnostics>;
}>> {
  if (params.service === undefined) return answerRerankResult("not_requested", 0, 0, null);
  if (params.queryText === null) return answerRerankResult("not_applicable", 0, 0, null);
  const candidates = [...params.candidates]
    .sort((left, right) => left.fusion.fused_rank - right.fusion.fused_rank)
    .slice(0, ANSWER_RERANK_BATCH_LIMIT);
  if (candidates.length === 0) return answerRerankResult("not_applicable", 0, 0, null);
  try {
    const scores = await params.service.score(
      params.queryText,
      candidates.map((candidate) => candidate.entry.content)
    );
    const failureClass = validateScores(scores, candidates.length);
    if (failureClass !== null) {
      params.warn("answer rerank returned an invalid score vector; preserving fusion order", {
        expected_count: candidates.length,
        actual_count: scores.length
      });
      return answerRerankResult(
        "failed",
        candidates.length,
        countValidScores(scores),
        failureClass
      );
    }
    const result = answerRerankResult("returned", candidates.length, scores.length, null);
    return Object.freeze({
      ...result,
      scores: new Map(candidates.map((candidate, index) => [
        candidate.fusion.candidate_key,
        scores[index]!
      ]))
    });
  } catch (error) {
    params.warn("answer rerank unavailable; preserving fusion order", {
      error: error instanceof Error ? error.message : String(error)
    });
    return answerRerankResult("failed", candidates.length, 0, "service_error");
  }
}

function validateScores(
  scores: readonly number[],
  expectedCount: number
): "invalid_score_count" | "invalid_score_value" | null {
  if (scores.length !== expectedCount) return "invalid_score_count";
  return countValidScores(scores) === scores.length ? null : "invalid_score_value";
}

function countValidScores(scores: readonly number[]): number {
  return scores.filter((score) => Number.isFinite(score) && score >= 0 && score <= 1).length;
}

function answerRerankResult(
  status: RecallAnswerRerankDiagnostics["status"],
  expectedCount: number,
  scoredCount: number,
  failureClass: RecallAnswerRerankDiagnostics["failure_class"]
) {
  return Object.freeze({
    scores: new Map<string, number>(),
    diagnostics: Object.freeze({
      status,
      expected_count: expectedCount,
      scored_count: scoredCount,
      failure_class: failureClass
    })
  });
}
