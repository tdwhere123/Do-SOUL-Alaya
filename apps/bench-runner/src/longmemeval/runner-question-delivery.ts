import { appendFileSync } from "node:fs";
import type { LongMemEvalQuestion } from "./dataset.js";
import { buildLongMemEvalSidecarKey, type LongMemEvalSidecarEntry } from "./runner-helpers.js";
import { scoreQaQuestion, type QaDeliveredCandidate, type QaQuestionVerdict } from "./qa-harness.js";
import type { QaChatFn } from "./qa-chat.js";
import { selectRelevantMemories } from "./qa-llm-filter.js";
import { buildQaSupportPack } from "./qa-support-pack.js";

const BENCH_PROFILE_ENV = "ALAYA_BENCH_PROFILE";
export const WIDE_QA_DELIVERY_QUESTION_TYPES = new Set([
  "knowledge-update",
  "multi-session",
  "locomo-aggregation"
]);

/** Read a positive-integer env override, else the fallback. */
function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

function isEnvExplicitlyDisabled(raw: string | undefined): boolean {
  if (raw === undefined) {
    return false;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized === "0" || normalized === "off" || normalized === "false";
}

export function resolveQaDeliveryBudget(questionType: string): {
  readonly deliverK: number;
  readonly useWideDelivery: boolean;
} {
  const deliverKRaw = Number(process.env.ALAYA_BENCH_QA_DELIVER_K);
  if (Number.isFinite(deliverKRaw) && deliverKRaw > 0) {
    return {
      deliverK: Math.floor(deliverKRaw),
      useWideDelivery: true
    };
  }
  const useWideDelivery =
    process.env.ALAYA_BENCH_QA_WIDE_AGG !== undefined &&
    WIDE_QA_DELIVERY_QUESTION_TYPES.has(questionType);
  return {
    deliverK: useWideDelivery ? 20 : 10,
    useWideDelivery
  };
}

export function shouldDedupQaDelivery(): boolean {
  return !isEnvExplicitlyDisabled(process.env.ALAYA_BENCH_QA_DEDUP_DELIVERY);
}

function normalizeQaDeliveryContent(content: string): string {
  return content.replace(/\s+/gu, " ").trim();
}

function qaDeliveryIdentity(candidate: QaDeliveredCandidate): string | null {
  const normalizedContent = normalizeQaDeliveryContent(candidate.content);
  if (normalizedContent.length === 0) {
    return null;
  }
  return `${candidate.eventDate?.trim() ?? ""}\u0000${normalizedContent}`;
}

export function dedupeQaDeliveredCandidates(
  delivered: readonly QaDeliveredCandidate[],
  maxCandidates = Number.POSITIVE_INFINITY
): QaDeliveredCandidate[] {
  const seen = new Set<string>();
  const unique: QaDeliveredCandidate[] = [];
  for (const candidate of delivered) {
    const key = qaDeliveryIdentity(candidate);
    if (key === null || seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(candidate);
    if (unique.length >= maxCandidates) {
      break;
    }
  }
  return unique;
}

interface QaSourceRecallPointer {
  readonly object_id: string;
  readonly object_kind?: string | null;
}

interface QaSidecarContent {
  readonly content?: string;
  readonly sessionId?: string | null;
  readonly eventDate?: string;
}

// sessionId stays a present string | null (not optional) so the session-spread
// generic still narrows; the looser QaDeliveredCandidate is a supertype.
interface QaSourceCandidate extends QaDeliveredCandidate {
  readonly sessionId: string | null;
}

/** Build the QA delivery candidate sets, ranking against the FULL recall list
 * rather than the memory_entry-filtered subsequence so a non-memory_entry
 * pointer ranked above does not understate sourceRank (and the gold-only path
 * carries sessionId + the gold's original recall rank). Pure: callers select
 * the final delivered set from these. */
export function buildQaDeliveredCandidates(input: {
  readonly results: readonly QaSourceRecallPointer[];
  readonly goldMemoryIds: readonly string[];
  readonly lookupMemoryEntry: (objectId: string) => QaSidecarContent | undefined;
  readonly lookupCandidate?: (
    objectKind: "memory_entry" | "synthesis_capsule",
    objectId: string
  ) => QaSidecarContent | undefined;
}): {
  readonly deliveryCandidates: QaSourceCandidate[];
  readonly memoryEntryCandidates: QaSourceCandidate[];
  readonly goldOnly: QaSourceCandidate[];
} {
  const lookupCandidate = (
    objectKind: "memory_entry" | "synthesis_capsule",
    objectId: string
  ): QaSidecarContent | undefined =>
    input.lookupCandidate?.(objectKind, objectId) ??
    (objectKind === "memory_entry" ? input.lookupMemoryEntry(objectId) : undefined);
  const deliveryCandidates = input.results
    .map((result, index) => ({ result, originalRank: index + 1 }))
    .filter(
      ({ result }) =>
        (result.object_kind ?? "memory_entry") === "memory_entry" ||
        result.object_kind === "synthesis_capsule"
    )
    .map(({ result, originalRank }) => {
      const objectKind = (result.object_kind ?? "memory_entry") as
        | "memory_entry"
        | "synthesis_capsule";
      const entry = lookupCandidate(objectKind, result.object_id);
      return {
        objectId: result.object_id,
        objectKind,
        content: entry?.content ?? "",
        sessionId: entry?.sessionId ?? null,
        sourceRank: originalRank,
        ...(entry?.eventDate === undefined ? {} : { eventDate: entry.eventDate })
      };
    });
  const memoryEntryCandidates = input.results
    .map((result, index) => ({ result, originalRank: index + 1 }))
    .filter(
      ({ result }) => (result.object_kind ?? "memory_entry") === "memory_entry"
    )
    .map(({ result, originalRank }) => {
      const entry = input.lookupMemoryEntry(result.object_id);
      return {
        objectId: result.object_id,
        content: entry?.content ?? "",
        sessionId: entry?.sessionId ?? null,
        sourceRank: originalRank,
        ...(entry?.eventDate === undefined ? {} : { eventDate: entry.eventDate })
      };
    });
  const originalRankById = new Map<string, number>();
  input.results.forEach((pointer, index) => {
    if ((pointer.object_kind ?? "memory_entry") !== "memory_entry") {
      return;
    }
    // keep the best (earliest) rank if an object_id recurs in results
    if (!originalRankById.has(pointer.object_id)) {
      originalRankById.set(pointer.object_id, index + 1);
    }
  });
  const goldOnly = input.goldMemoryIds.map((id) => {
    const entry = input.lookupMemoryEntry(id);
    const goldRank = originalRankById.get(id);
    return {
      objectId: id,
      content: entry?.content ?? "",
      sessionId: entry?.sessionId ?? null,
      // gold absent from results => no recall rank; leave sourceRank unset.
      ...(goldRank === undefined ? {} : { sourceRank: goldRank }),
      ...(entry?.eventDate === undefined ? {} : { eventDate: entry.eventDate })
    };
  });
  return { deliveryCandidates, memoryEntryCandidates, goldOnly };
}

/** Round-robin across the source sessions of the recalled pool so one
 * high-match session can't bury other answer sessions' gold below the delivery
 * budget. Reshapes QA delivery selection only (post-recall); recall-service is
 * untouched. Pair with a wide ALAYA_BENCH_RECALL_MAXK so the deep gold is in
 * the pool to redistribute. */
function selectSessionSpread<T extends { readonly sessionId: string | null }>(
  pool: readonly T[]
): T[] {
  const bySession = new Map<string, T[]>();
  for (const pointer of pool) {
    const sessionId = pointer.sessionId ?? "?";
    const bucket = bySession.get(sessionId);
    if (bucket === undefined) bySession.set(sessionId, [pointer]);
    else bucket.push(pointer);
  }
  // Map insertion order = each session's first (best) fusion rank.
  const buckets = [...bySession.values()];
  const picked: T[] = [];
  for (let depth = 0; ; depth += 1) {
    let progressed = false;
    for (const bucket of buckets) {
      const item = bucket[depth];
      if (item !== undefined) {
        picked.push(item);
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  return picked;
}

function buildQaSupportCandidatesFromSidecar(
  sidecar: ReadonlyMap<string, LongMemEvalSidecarEntry>
): QaSourceCandidate[] {
  return [...sidecar.values()]
    .filter((entry) => entry.objectKind === "memory_entry")
    .map((entry) => ({
      objectId: entry.objectId,
      objectKind: "memory_entry" as const,
      content: entry.content ?? "",
      sessionId: entry.sessionId,
      ...(entry.eventDate === undefined ? {} : { eventDate: entry.eventDate })
    }));
}

export function isBenchProfileEnabled(): boolean {
  const raw = process.env[BENCH_PROFILE_ENV];
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  return (
    normalized !== "" &&
    normalized !== "0" &&
    normalized !== "false" &&
    normalized !== "off" &&
    normalized !== "no"
  );
}

interface PhaseTimer {
  readonly tick: () => bigint;
  readonly record: (name: string, started: bigint) => void;
  readonly format: () => string;
}

export function createPhaseTimer(): PhaseTimer {
  const samples: Array<{ name: string; ms: number }> = [];
  return {
    tick: () => process.hrtime.bigint(),
    record: (name: string, started: bigint) => {
      const elapsedNs = process.hrtime.bigint() - started;
      const ms = Number(elapsedNs) / 1_000_000;
      samples.push({ name, ms });
    },
    format: () => samples.map((s) => `${s.name}=${s.ms.toFixed(1)}ms`).join(" ")
  };
}


export async function scoreLongMemEvalQaIfRequested(input: {
  readonly question: LongMemEvalQuestion;
  readonly qaChat?: QaChatFn;
  readonly qaJudgeChat?: QaChatFn;
  readonly isAbstention: boolean;
  readonly results: readonly { readonly object_id: string; readonly object_kind?: string | null }[];
  readonly goldMemoryIds: readonly string[];
  readonly sidecar: ReadonlyMap<string, LongMemEvalSidecarEntry>;
}): Promise<QaQuestionVerdict | undefined> {
  const { results, goldMemoryIds, sidecar, isAbstention } = input;
let qaVerdict: QaQuestionVerdict | undefined;
if (input.qaChat !== undefined) {
  // QA delivery budget (default 10 = unchanged). ALAYA_BENCH_QA_DELIVER_K
  // widens it so the aggregation reader sees more of a counting question's
  // scattered gold; session-spread (default off) redistributes that budget
  // across source sessions. Recall-service untouched.
  // Aggregation/latest-value questions want a wide budget so scattered gold
  // reaches the reader; precise types (temporal) are hurt by extra dated
  // candidates, so they stay narrow. ALAYA_BENCH_QA_WIDE_AGG turns on the
  // type-aware budget; ALAYA_BENCH_QA_DELIVER_K is a global A/B override.
  const { deliverK } = resolveQaDeliveryBudget(input.question.question_type);
  const { deliveryCandidates, memoryEntryCandidates, goldOnly } = buildQaDeliveredCandidates({
    results,
    goldMemoryIds,
    lookupMemoryEntry: (objectId) =>
      sidecar.get(buildLongMemEvalSidecarKey("memory_entry", objectId)),
    lookupCandidate: (objectKind, objectId) =>
      sidecar.get(buildLongMemEvalSidecarKey(objectKind, objectId))
  });
  const supportCandidates = buildQaSupportCandidatesFromSidecar(sidecar);
  const goldOnlyRequested =
    process.env.ALAYA_BENCH_DELIVER_GOLD_ONLY !== undefined;
  const deliveryPool =
    process.env.ALAYA_BENCH_QA_SESSION_SPREAD !== undefined
      ? selectSessionSpread(deliveryCandidates)
      : deliveryCandidates;
  let delivered: QaDeliveredCandidate[] = goldOnlyRequested
    ? goldOnly
    : shouldDedupQaDelivery()
      ? dedupeQaDeliveredCandidates(deliveryPool, deliverK)
      : deliveryPool.slice(0, deliverK);
  // Agent-side LLM relevance filter: retrieve WIDE (catch precise-class gold
  // buried at rank 12-15), let an LLM pick the few relevant memories, deliver
  // NARROW clean context. Decouples retrieve-width from deliver-width — the
  // semantic selection fusion ranking can't do (§D wall). Default off.
  if (
    !goldOnlyRequested &&
    process.env.ALAYA_BENCH_QA_LLM_FILTER !== undefined &&
    input.qaChat !== undefined
  ) {
    const filterK = readPositiveIntEnv("ALAYA_BENCH_QA_LLM_FILTER_K", 30);
    const filterM = readPositiveIntEnv("ALAYA_BENCH_QA_LLM_FILTER_M", 8);
    const widePool: QaDeliveredCandidate[] = shouldDedupQaDelivery()
      ? dedupeQaDeliveredCandidates(deliveryCandidates, filterK)
      : deliveryCandidates
          .filter((cand) => normalizeQaDeliveryContent(cand.content).length > 0)
          .slice(0, filterK);
    const selected = await selectRelevantMemories(
      input.question.question,
      widePool,
      filterM,
      input.qaChat
    );
    if (selected.length > 0) {
      delivered = shouldDedupQaDelivery()
        ? dedupeQaDeliveredCandidates(selected, filterM)
        : selected.slice(0, filterM);
    }
  }
  // Support pack: deterministically expand the filtered anchors with their
  // same-session neighbours so a needed date/number/before-after value the
  // filter skipped still reaches the reader. Default-off; agent-sim layer.
  if (!goldOnlyRequested && process.env.ALAYA_BENCH_QA_SUPPORT_PACK !== undefined) {
    delivered = buildQaSupportPack({
      questionType: input.question.question_type,
      selected: delivered,
      widePool: deliveryCandidates,
      supportPool: supportCandidates,
      maxDeliver: readPositiveIntEnv("ALAYA_BENCH_QA_SUPPORT_PACK_MAX", 16)
    });
  }
  // Diagnostic oracle: replace delivered recall with ONLY the materialized
  // gold memories (no distractors), to isolate ingestion-drop from recall
  // ranking/noise. Gold not materialized at ingestion is absent here too.
  // It still runs through the same identity-based dedup contract so a
  // duplicated gold turn cannot artificially shrink or inflate QA context.
  if (goldOnlyRequested && shouldDedupQaDelivery()) {
    delivered = dedupeQaDeliveredCandidates(delivered);
  }
  qaVerdict = await scoreQaQuestion(
    {
      questionId: input.question.question_id,
      questionType: input.question.question_type,
      isAbstention,
      question: input.question.question,
      questionDate: input.question.question_date,
      goldAnswer: input.question.answer,
      delivered
    },
    input.qaChat,
    input.qaJudgeChat ?? input.qaChat
  );
  // Diagnostic: dump the delivered context + model answer + judge verdict as
  // JSONL, so failing questions can be read by hand to split "delivered text
  // lacks the answer" (ingestion-drop) from "delivered text has it but the
  // reader answered wrong" (reader). Pairs with DELIVER_GOLD_ONLY to isolate
  // the oracle ceiling. Default off; set ALAYA_BENCH_QA_DUMP to a file path.
  if (process.env.ALAYA_BENCH_QA_DUMP !== undefined) {
    // Failure split: locate gold in the wide pool vs the delivered set so a
    // wrong answer is attributable to recall (gold never retrieved), the
    // selector/support layer (retrieved but not delivered), or the reader
    // (delivered but answered wrong). Finer judge/ingestion splits stay for
    // manual review off the raw gold-presence fields.
    const goldIdSet = new Set(goldMemoryIds);
    const widePoolGoldRanks = memoryEntryCandidates
      .filter((c) => goldIdSet.has(c.objectId) && normalizeQaDeliveryContent(c.content).length > 0)
      .map((c) => c.sourceRank);
    const goldInWidePool = widePoolGoldRanks.length > 0;
    const goldInDelivered = delivered.some((d) => goldIdSet.has(d.objectId));
    const failureClass = qaVerdict.correct
      ? null
      : !goldInWidePool
        ? "recall_miss"
        : !goldInDelivered
          ? "support_selector_miss"
          : "reader_miss";
    appendFileSync(
      process.env.ALAYA_BENCH_QA_DUMP,
      JSON.stringify({
        questionId: input.question.question_id,
        questionType: input.question.question_type,
        question: input.question.question,
        questionDate: input.question.question_date,
        goldAnswer: input.question.answer,
        modelAnswer: qaVerdict.modelAnswer,
        judgeVerdict: qaVerdict.judgeVerdict,
        correct: qaVerdict.correct,
        goldInWidePool,
        goldInDelivered,
        failureClass,
        widePoolGoldRanks,
        deliveredGoldOnly:
          process.env.ALAYA_BENCH_DELIVER_GOLD_ONLY !== undefined,
        delivered: delivered.map((d) => ({
          objectId: d.objectId,
          ...(d.eventDate === undefined ? {} : { eventDate: d.eventDate }),
          ...(d.sessionId == null ? {} : { sessionId: d.sessionId }),
          ...(d.sourceRank === undefined ? {} : { sourceRank: d.sourceRank }),
          content: d.content.replace(/\s+/gu, " ")
        }))
      }) + "\n"
    );
  }
}
  return qaVerdict;
}
