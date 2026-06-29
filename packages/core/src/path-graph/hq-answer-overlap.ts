import type { AnswerCoRelevancePairSourcePort } from "./answers-with-edge-producer-service.js";

// Default min shared content-token count for an answers_with edge; bench-tunable.
export const DEFAULT_ANSWER_OVERLAP_BAR = 3;

// Question-template + high-frequency function words stripped before overlap so two
// HQ pools do not "co-answer" merely by sharing "what/how/the/is". Only content
// tokens drive the signal. CJK question markers included defensively.
const HQ_STOPWORDS: ReadonlySet<string> = new Set([
  "what", "how", "when", "where", "who", "why", "which", "whose", "whom",
  "is", "are", "was", "were", "be", "been", "being", "am",
  "do", "does", "did", "done", "doing",
  "have", "has", "had", "having",
  "will", "would", "shall", "should", "can", "could", "may", "might", "must",
  "the", "a", "an", "of", "to", "in", "on", "at", "for", "by", "from", "with",
  "and", "or", "but", "if", "as", "so", "than", "then", "that", "this", "these", "those",
  "into", "over", "about", "out", "up", "down", "off",
  "it", "its", "they", "them", "their", "you", "your", "yours",
  "he", "she", "his", "her", "we", "our", "us", "i", "my", "me", "mine",
  "not", "no", "yes",
  "什么", "如何", "怎么", "怎样", "何时", "哪里", "为什么", "是否"
]);

// Pool a memory's HQ list into one normalized content-token set: lowercase, split
// on non-alphanumeric (unicode), drop stopwords and single-char tokens.
export function normalizeHqTokens(hqs: readonly string[]): ReadonlySet<string> {
  const tokens = new Set<string>();
  for (const hq of hqs) {
    for (const raw of hq.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
      if (raw.length >= 2 && !HQ_STOPWORDS.has(raw)) {
        tokens.add(raw);
      }
    }
  }
  return tokens;
}

function sharedTokenCount(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const token of small) {
    if (large.has(token)) {
      shared += 1;
    }
  }
  return shared;
}

// Pairs of objects whose pooled HQ content-token sets share >= bar tokens, as
// canonical `${low}|${high}` keys. Objects without HQ never pair. O(n^2) over the
// candidate batch (same shape as coherentPairKeys), fine for per-question/backfill sizes.
export function answerCoRelevantPairKeysFromHq(
  hqByObjectId: ReadonlyMap<string, readonly string[]>,
  objectIds: readonly string[],
  bar: number
): ReadonlySet<string> {
  const tokenSets = new Map<string, ReadonlySet<string>>();
  for (const objectId of objectIds) {
    const hqs = hqByObjectId.get(objectId);
    if (hqs !== undefined && hqs.length > 0) {
      tokenSets.set(objectId, normalizeHqTokens(hqs));
    }
  }
  const withTokens = [...tokenSets.keys()];
  const pairs = new Set<string>();
  for (let i = 0; i < withTokens.length; i += 1) {
    for (let j = i + 1; j < withTokens.length; j += 1) {
      const a = withTokens[i]!;
      const b = withTokens[j]!;
      if (sharedTokenCount(tokenSets.get(a)!, tokenSets.get(b)!) >= bar) {
        const [low, high] = a < b ? [a, b] : [b, a];
        pairs.add(`${low}|${high}`);
      }
    }
  }
  return pairs;
}

export interface MemoryHqReadPort {
  getHqByObjectIds(
    objectIds: readonly string[]
  ): Promise<ReadonlyMap<string, readonly string[]>>;
}

// AnswerCoRelevancePairSourcePort backed by the memory_hq store: read HQ then run
// the pure overlap metric. Truth-boundary producers depend only on the port.
export class HqAnswerOverlapPairSource implements AnswerCoRelevancePairSourcePort {
  public constructor(private readonly hqRepo: MemoryHqReadPort) {}

  public async answerCoRelevantPairKeys(params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly objectIds: readonly string[];
    readonly bar: number;
  }): Promise<ReadonlySet<string>> {
    const hqByObjectId = await this.hqRepo.getHqByObjectIds(params.objectIds);
    return answerCoRelevantPairKeysFromHq(hqByObjectId, params.objectIds, params.bar);
  }
}
