import type { AnswerCoRelevancePairSourcePort } from "./answers-with-edge-producer-service.js";

// Default min shared content-token count for an answers_with edge; bench-tunable.
export const DEFAULT_ANSWER_OVERLAP_BAR = 3;

// Latin question-template + high-frequency function words stripped before overlap so
// two HQ pools do not "co-answer" merely by sharing "what/how/the/is". CJK templates
// live in CJK_STOPWORD_BIGRAMS (different segmentation, different unit).
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
  "not", "no", "yes"
]);

// Scripts whose runs carry no word delimiters; segmented by character bigram below.
// Add a new delimiter-less script here (e.g. Thai) to extend multilingual coverage.
const CJK_SCRIPT_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const WORD_CHAR_RE = /[\p{L}\p{N}]/u;

// Chinese question-template / function bigrams stripped so two CJK HQ pools do not
// "co-answer" merely by sharing "什么/如何/是否/时候". Multi-char templates register
// their core bigrams (什么时候 -> 什么 + 时候).
const CJK_STOPWORD_BIGRAMS: ReadonlySet<string> = new Set([
  "什么", "为什", "时候", "如何", "怎么", "怎样", "何时", "为何",
  "哪里", "哪个", "哪些", "是否", "多少", "几个", "可以", "能否"
]);

// Pool a memory's HQ list into one normalized content-token set. Latin/other word
// runs split on punctuation/whitespace (byte-identical to non-CJK pre-N1 behavior);
// CJK runs lack delimiters so they segment by character bigram (sharper than unigram:
// single Han chars over-match; one shared bigram ~= one shared Latin word, keeping the
// overlap bar self-consistent across scripts).
export function normalizeHqTokens(hqs: readonly string[]): ReadonlySet<string> {
  const tokens = new Set<string>();
  for (const hq of hqs) {
    let latin = "";
    let cjk = "";
    const flushLatin = (): void => {
      if (latin.length >= 2 && !HQ_STOPWORDS.has(latin)) {
        tokens.add(latin);
      }
      latin = "";
    };
    const flushCjk = (): void => {
      addCjkBigrams(cjk, tokens);
      cjk = "";
    };
    for (const ch of hq.toLowerCase()) {
      if (CJK_SCRIPT_RE.test(ch)) {
        flushLatin();
        cjk += ch;
      } else if (WORD_CHAR_RE.test(ch)) {
        flushCjk();
        latin += ch;
      } else {
        flushLatin();
        flushCjk();
      }
    }
    flushLatin();
    flushCjk();
  }
  return tokens;
}

function addCjkBigrams(run: string, tokens: Set<string>): void {
  const chars = [...run];
  if (chars.length === 1) {
    tokens.add(chars[0]!);
    return;
  }
  for (let i = 0; i + 1 < chars.length; i += 1) {
    const bigram = chars[i]! + chars[i + 1]!;
    if (!CJK_STOPWORD_BIGRAMS.has(bigram)) {
      tokens.add(bigram);
    }
  }
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
