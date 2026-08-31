import { createHash } from "node:crypto";
import type {
  AnswerCoRelevancePairSourcePort,
  AnswerCoRelevancePairWitness
} from "./answers-with-edge-producer-service.js";
import { stableStringify } from "../../shared/stable-stringify.js";

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

export const ANSWER_OVERLAP_POLICY_ID = "hq_answer_overlap_v1";
export const ANSWER_OVERLAP_POLICY_SHA256 = sha256(JSON.stringify({
  policy_id: ANSWER_OVERLAP_POLICY_ID,
  latin_stopwords: [...HQ_STOPWORDS].sort(),
  cjk_stopword_bigrams: [...CJK_STOPWORD_BIGRAMS].sort(),
  segmentation: "unicode-word-runs-and-cjk-bigrams-v1"
}));

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

function sharedTokens(a: ReadonlySet<string>, b: ReadonlySet<string>): readonly string[] {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  return Object.freeze([...small].filter((token) => large.has(token)).sort());
}

export function answerCoRelevantPairWitnessesFromHq(
  observationByObjectId: ReadonlyMap<string, Readonly<MemoryHqObservation>>,
  objectIds: readonly string[],
  bar: number
): readonly AnswerCoRelevancePairWitness[] {
  const tokenSets = new Map<string, ReadonlySet<string>>();
  for (const objectId of objectIds) {
    const observation = observationByObjectId.get(objectId);
    if (observation !== undefined && observation.hqs.length > 0) {
      tokenSets.set(objectId, normalizeHqTokens(observation.hqs));
    }
  }
  const withTokens = [...tokenSets.keys()];
  const witnesses: AnswerCoRelevancePairWitness[] = [];
  for (let leftIndex = 0; leftIndex < withTokens.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < withTokens.length; rightIndex += 1) {
      const leftId = withTokens[leftIndex]!;
      const rightId = withTokens[rightIndex]!;
      const shared = sharedTokens(tokenSets.get(leftId)!, tokenSets.get(rightId)!);
      if (shared.length < bar) continue;
      const left = observationByObjectId.get(leftId)!;
      const right = observationByObjectId.get(rightId)!;
      witnesses.push(buildPairWitness(left, right, bar, shared));
    }
  }
  return Object.freeze(witnesses);
}

export interface MemoryHqObservation {
  readonly observation_id: string;
  readonly object_id: string;
  readonly workspace_id: string;
  readonly hqs: readonly string[];
  readonly evidence_receipt: AnswerCoRelevancePairWitness["evidenceReceipts"][number];
  readonly hq_content_sha256: string;
  readonly observation_sha256: string;
}

export interface MemoryHqReadPort {
  getObservationsByObjectIds(
    objectIds: readonly string[]
  ): Promise<ReadonlyMap<string, Readonly<MemoryHqObservation>>>;
}

export class HqAnswerOverlapPairSource implements AnswerCoRelevancePairSourcePort {
  public constructor(private readonly hqRepo: MemoryHqReadPort) {}

  public async answerCoRelevantPairs(params: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly objectIds: readonly string[];
    readonly bar: number;
  }): Promise<readonly AnswerCoRelevancePairWitness[]> {
    const observations = await this.hqRepo.getObservationsByObjectIds(params.objectIds);
    for (const observation of observations.values()) {
      if (observation.workspace_id !== params.workspaceId) {
        throw new Error(`HQ observation ${observation.observation_id} belongs to another workspace.`);
      }
    }
    return answerCoRelevantPairWitnessesFromHq(observations, params.objectIds, params.bar);
  }
}

function buildPairWitness(
  left: Readonly<MemoryHqObservation>,
  right: Readonly<MemoryHqObservation>,
  bar: number,
  shared: readonly string[]
): AnswerCoRelevancePairWitness {
  const [source, target] = left.object_id < right.object_id ? [left, right] : [right, left];
  const evidenceReceipts = uniqueEvidenceReceipts([source.evidence_receipt, target.evidence_receipt]);
  const sourceObservations = [source, target]
    .map((observation) => ({
      source_kind: "memory_hq_observation" as const,
      source_id: observation.observation_id,
      source_sha256: observation.observation_sha256
    }))
    .sort((a, b) => a.source_id.localeCompare(b.source_id));
  const parameters = { bar };
  const decision = {
    shared_token_count: shared.length,
    shared_token_sha256: sha256(JSON.stringify(shared))
  };
  return Object.freeze({
    pair: Object.freeze([source.object_id, target.object_id] as const),
    evidenceReceipts,
    formationReceipt: {
      operator_id: ANSWER_OVERLAP_POLICY_ID,
      operator_sha256: ANSWER_OVERLAP_POLICY_SHA256,
      parameters,
      parameter_sha256: sha256(stableStringify(parameters)),
      source_observations: sourceObservations,
      decision,
      decision_sha256: sha256(stableStringify(decision))
    },
    validFrom: evidenceReceipts.reduce(
      (latest, receipt) => latest < receipt.source_event_anchor.occurred_at
        ? receipt.source_event_anchor.occurred_at
        : latest,
      evidenceReceipts[0]!.source_event_anchor.occurred_at
    )
  });
}

function uniqueEvidenceReceipts(
  receipts: readonly AnswerCoRelevancePairWitness["evidenceReceipts"][number][]
): AnswerCoRelevancePairWitness["evidenceReceipts"] {
  const byId = new Map<string, AnswerCoRelevancePairWitness["evidenceReceipts"][number]>();
  for (const receipt of receipts) {
    const existing = byId.get(receipt.evidence_id);
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(receipt)) {
      throw new Error(`Evidence ${receipt.evidence_id} has conflicting HQ source events.`);
    }
    byId.set(receipt.evidence_id, receipt);
  }
  return Object.freeze([...byId.values()].sort((a, b) => a.evidence_id.localeCompare(b.evidence_id)));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
