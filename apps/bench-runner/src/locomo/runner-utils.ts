import { resolveBenchCommitSha7 } from "../shared/version.js";
import type {
  BenchEmbeddingWarmupSummary,
  BenchQueryEmbeddingWarmupSummary
} from "../harness/daemon.js";
import { extractSessions, type LocomoQa, type LocomoSample, type LocomoTurn } from "./dataset.js";
import type {
  LocomoEmbeddingVectorCacheSummary,
  LocomoQueryEmbeddingCacheSummary,
  LocomoRunOptions
} from "./runner-types.js";

export function computePercentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)] ?? 0;
}

export function summarizeEmbeddingVectorCache(
  summaries: readonly BenchEmbeddingWarmupSummary[]
): LocomoEmbeddingVectorCacheSummary | null {
  const readySummaries = summaries.filter((summary) => summary.status === "ready");
  if (readySummaries.length === 0) {
    return null;
  }

  const expectedCount = readySummaries.reduce(
    (sum, summary) => sum + summary.expected_count,
    0
  );
  const readyCount = readySummaries.reduce(
    (sum, summary) => sum + summary.ready_count,
    0
  );
  const maxPassCount = readySummaries.reduce(
    (max, summary) => Math.max(max, summary.pass_count),
    0
  );

  return {
    expected_count: expectedCount,
    ready_count: readyCount,
    not_ready_count: Math.max(0, expectedCount - readyCount),
    ready_rate: expectedCount === 0 ? 0 : readyCount / expectedCount,
    max_pass_count: maxPassCount
  };
}

export function summarizeQueryEmbeddingCache(
  summaries: readonly BenchQueryEmbeddingWarmupSummary[]
): LocomoQueryEmbeddingCacheSummary | null {
  const readySummaries = summaries.filter((summary) => summary.status === "ready");
  if (readySummaries.length === 0) {
    return null;
  }

  const requestedCount = readySummaries.reduce(
    (sum, summary) => sum + summary.requested_count,
    0
  );
  const readyCount = readySummaries.reduce(
    (sum, summary) => sum + summary.ready_count,
    0
  );
  const cacheHitCount = readySummaries.reduce(
    (sum, summary) => sum + summary.cache_hit_count,
    0
  );
  const providerRequestedCount = readySummaries.reduce(
    (sum, summary) => sum + summary.provider_requested_count,
    0
  );
  const lastError = [...readySummaries].reverse().find((summary) => summary.last_error !== undefined)?.last_error;

  return {
    requested_count: requestedCount,
    ready_count: readyCount,
    not_ready_count: Math.max(0, requestedCount - readyCount),
    ready_rate: requestedCount === 0 ? 0 : readyCount / requestedCount,
    cache_hit_count: cacheHitCount,
    provider_requested_count: providerRequestedCount,
    ...(lastError === undefined ? {} : { last_error: lastError })
  };
}

export function resolveCommitSha7(): string {
  return resolveBenchCommitSha7();
}

// invariant: sample_size counts the retrieval denominator across the full
// dataset (every QA carrying non-empty evidence), not the number of
// conversations. Answerless adversarial rows still exercise retrieval when
// they point at gold evidence; abstention only changes the optional QA judge
// path. evaluated_count is the subset this run actually scored, so
// evaluated_count <= sample_size holds even when --limit slices the
// conversation window.
export function resolveLocomoSampleSize(
  conversations: readonly LocomoSample[]
): number {
  let total = 0;
  for (const conv of conversations) {
    for (const qa of conv.qa) {
      if (hasLocomoRetrievalEvidence(qa)) {
        total += 1;
      }
    }
  }
  return total;
}

// invariant: identical seed string at both call sites (live seed + extraction
// cache-key collection), else the extraction cache key mismatches and seeds
// diverge. Image turns splice blip_caption / query so the answer signal a
// deictic text ("take a look") drops is recoverable by lexical recall.
export function buildLocomoSeedContent(turn: LocomoTurn): string {
  const caption = turn.blip_caption?.trim() ?? "";
  const query = turn.query?.trim() ?? "";
  return [
    `${turn.speaker}: ${turn.text}`,
    caption.length > 0 ? `[image: ${caption}]` : "",
    query.length > 0 ? `[image query: ${query}]` : ""
  ]
    .filter((part) => part.length > 0)
    .join(" ");
}

export function collectDistinctLocomoTurnContents(
  conversations: readonly LocomoSample[]
): readonly string[] {
  const turns = new Set<string>();
  for (const conversation of conversations) {
    for (const session of extractSessions(conversation.conversation)) {
      for (const turn of session.turns) {
        const content = buildLocomoSeedContent(turn).trim();
        if (content.length > 0) {
          turns.add(content);
        }
      }
    }
  }
  return [...turns];
}

export function hasLocomoRetrievalEvidence(qa: LocomoQa): boolean {
  return qa.evidence.length > 0;
}

export function isLocomoAbstentionQa(qa: LocomoQa): boolean {
  return qa.answer.trim().length === 0;
}

export function resolveLocomoQaGoldAnswer(qa: LocomoQa): string {
  if (!isLocomoAbstentionQa(qa)) {
    return qa.answer;
  }
  return "The conversation does not provide enough information to answer this question.";
}

export function shouldRunLocomoRecall(
  qa: LocomoQa,
  opts: LocomoRunOptions
): boolean {
  return hasLocomoRetrievalEvidence(qa) || opts.qa !== undefined;
}

export function resolveLocomoQaQuestionType(qa: LocomoQa): string {
  if (qa.category === 2) {
    return "temporal-reasoning";
  }
  if (qa.category === 3) {
    return "locomo-aggregation";
  }
  if (qa.category === 4) {
    return "locomo-open-domain";
  }
  return "locomo-factual";
}

export function readPositiveEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

export function buildLocomoQuestionId(sampleId: string, qaIndex: number): string {
  return `${sampleId}:${qaIndex + 1}`;
}

export function resolveLocomoGoldMemoryIds(input: {
  readonly questionId: string;
  readonly evidenceSet: ReadonlySet<string>;
  readonly memoryIdsByDiaId: ReadonlyMap<string, readonly string[]>;
}): string[] {
  const goldMemoryIds: string[] = [];
  const missingDiaIds: string[] = [];
  for (const diaId of input.evidenceSet) {
    const memoryIds = input.memoryIdsByDiaId.get(diaId) ?? [];
    if (memoryIds.length === 0) {
      missingDiaIds.push(diaId);
      continue;
    }
    goldMemoryIds.push(...memoryIds);
  }
  if (missingDiaIds.length > 0) {
    throw new Error(
      `LoCoMo seed materialization lost gold evidence for ${input.questionId}: ` +
        missingDiaIds.join(", ")
    );
  }
  return goldMemoryIds;
}
