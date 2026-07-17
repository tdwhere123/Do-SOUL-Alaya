import type { LongMemEvalQuestion } from "../../ingestion/dataset.js";
import { buildLongMemEvalSidecarKey, type LongMemEvalSidecarEntry } from "../runner-helpers.js";
import { scoreQaQuestion, type QaDeliveredCandidate, type QaQuestionVerdict } from "../../qa/qa-harness.js";
import type { QaChatFn } from "../../qa/qa-chat.js";
import { selectRelevantMemories } from "../../qa/qa-llm-filter.js";
import { buildQaSupportPack } from "../../qa/qa-support-pack.js";
import { normalizeQaDeliveryContent } from "./delivery/qa-delivery-content.js";
import { dumpQaDeliveryDiagnostic } from "./delivery/qa-delivery-diagnostics.js";

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

type QaCandidateLookup = (
  objectKind: "memory_entry" | "synthesis_capsule",
  objectId: string
) => QaSidecarContent | undefined;

interface QaDeliveryCandidateSets {
  readonly deliveryCandidates: QaSourceCandidate[];
  readonly memoryEntryCandidates: QaSourceCandidate[];
  readonly goldOnly: QaSourceCandidate[];
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
}): QaDeliveryCandidateSets {
  const lookupCandidate = resolveQaCandidateLookup(input);
  const memoryEntryRanks = indexMemoryEntryRanks(input.results);
  return {
    deliveryCandidates: buildDeliveryCandidates(input.results, lookupCandidate),
    memoryEntryCandidates: buildMemoryEntryCandidates(input.results, input.lookupMemoryEntry),
    goldOnly: buildGoldOnlyCandidates(
      input.goldMemoryIds,
      input.lookupMemoryEntry,
      memoryEntryRanks
    )
  };
}

function resolveQaCandidateLookup(input: Parameters<typeof buildQaDeliveredCandidates>[0]): QaCandidateLookup {
  return (objectKind, objectId) =>
    input.lookupCandidate?.(objectKind, objectId) ??
    (objectKind === "memory_entry" ? input.lookupMemoryEntry(objectId) : undefined);
}

function buildDeliveryCandidates(
  results: readonly QaSourceRecallPointer[],
  lookupCandidate: QaCandidateLookup
): QaSourceCandidate[] {
  const candidates: QaSourceCandidate[] = [];
  for (const [index, result] of results.entries()) {
    const objectKind = result.object_kind ?? "memory_entry";
    if (objectKind !== "memory_entry" && objectKind !== "synthesis_capsule") continue;
    const entry = lookupCandidate(objectKind, result.object_id);
    candidates.push({
      objectId: result.object_id,
      objectKind,
      content: entry?.content ?? "",
      sessionId: entry?.sessionId ?? null,
      sourceRank: index + 1,
      ...(entry?.eventDate === undefined ? {} : { eventDate: entry.eventDate })
    });
  }
  return candidates;
}

function buildMemoryEntryCandidates(
  results: readonly QaSourceRecallPointer[],
  lookupMemoryEntry: (objectId: string) => QaSidecarContent | undefined
): QaSourceCandidate[] {
  const candidates: QaSourceCandidate[] = [];
  for (const [index, result] of results.entries()) {
    if ((result.object_kind ?? "memory_entry") !== "memory_entry") continue;
    const entry = lookupMemoryEntry(result.object_id);
    candidates.push({
      objectId: result.object_id,
      content: entry?.content ?? "",
      sessionId: entry?.sessionId ?? null,
      sourceRank: index + 1,
      ...(entry?.eventDate === undefined ? {} : { eventDate: entry.eventDate })
    });
  }
  return candidates;
}

function indexMemoryEntryRanks(
  results: readonly QaSourceRecallPointer[]
): ReadonlyMap<string, number> {
  const ranks = new Map<string, number>();
  for (const [index, pointer] of results.entries()) {
    if ((pointer.object_kind ?? "memory_entry") === "memory_entry") {
      ranks.set(pointer.object_id, ranks.get(pointer.object_id) ?? index + 1);
    }
  }
  return ranks;
}

function buildGoldOnlyCandidates(
  goldMemoryIds: readonly string[],
  lookupMemoryEntry: (objectId: string) => QaSidecarContent | undefined,
  memoryEntryRanks: ReadonlyMap<string, number>
): QaSourceCandidate[] {
  return goldMemoryIds.map((id) => {
    const entry = lookupMemoryEntry(id);
    const goldRank = memoryEntryRanks.get(id);
    return {
      objectId: id,
      content: entry?.content ?? "",
      sessionId: entry?.sessionId ?? null,
      ...(goldRank === undefined ? {} : { sourceRank: goldRank }),
      ...(entry?.eventDate === undefined ? {} : { eventDate: entry.eventDate })
    };
  });
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


interface QaDeliverySelection {
  readonly delivered: QaDeliveredCandidate[];
  readonly memoryEntryCandidates: QaSourceCandidate[];
}

async function resolveQaDeliverySelection(input: {
  readonly question: LongMemEvalQuestion;
  readonly qaChat: QaChatFn;
  readonly results: readonly QaSourceRecallPointer[];
  readonly goldMemoryIds: readonly string[];
  readonly sidecar: ReadonlyMap<string, LongMemEvalSidecarEntry>;
}): Promise<QaDeliverySelection> {
  const candidates = buildQaDeliveryCandidatesForQuestion(input);
  const goldOnlyRequested = process.env.ALAYA_BENCH_DELIVER_GOLD_ONLY !== undefined;
  const delivered = await refineQaDeliveryCandidates(
    input,
    candidates,
    goldOnlyRequested
  );
  return { delivered, memoryEntryCandidates: candidates.memoryEntryCandidates };
}

function buildQaDeliveryCandidatesForQuestion(input: Parameters<typeof resolveQaDeliverySelection>[0]) {
  const candidates = buildQaDeliveredCandidates({
    results: input.results,
    goldMemoryIds: input.goldMemoryIds,
    lookupMemoryEntry: (objectId) =>
      input.sidecar.get(buildLongMemEvalSidecarKey("memory_entry", objectId)),
    lookupCandidate: (objectKind, objectId) =>
      input.sidecar.get(buildLongMemEvalSidecarKey(objectKind, objectId))
  });
  return { ...candidates, supportCandidates: buildQaSupportCandidatesFromSidecar(input.sidecar) };
}

async function refineQaDeliveryCandidates(
  input: Parameters<typeof resolveQaDeliverySelection>[0],
  candidates: ReturnType<typeof buildQaDeliveryCandidatesForQuestion>,
  goldOnlyRequested: boolean
): Promise<QaDeliveredCandidate[]> {
  let delivered = selectInitialQaDelivery(
    candidates.deliveryCandidates,
    candidates.goldOnly,
    input.question.question_type,
    goldOnlyRequested
  );
  if (!goldOnlyRequested && process.env.ALAYA_BENCH_QA_LLM_FILTER !== undefined) {
    delivered = await applyQaLlmFilter(
      input.question.question,
      candidates.deliveryCandidates,
      delivered,
      input.qaChat
    );
  }
  if (!goldOnlyRequested && process.env.ALAYA_BENCH_QA_SUPPORT_PACK !== undefined) {
    delivered = buildQaSupportPack({
      questionType: input.question.question_type,
      selected: delivered,
      widePool: candidates.deliveryCandidates,
      supportPool: candidates.supportCandidates,
      maxDeliver: readPositiveIntEnv("ALAYA_BENCH_QA_SUPPORT_PACK_MAX", 16)
    });
  }
  return goldOnlyRequested && shouldDedupQaDelivery()
    ? dedupeQaDeliveredCandidates(delivered)
    : delivered;
}

function selectInitialQaDelivery(
  deliveryCandidates: readonly QaSourceCandidate[],
  goldOnly: QaSourceCandidate[],
  questionType: string,
  goldOnlyRequested: boolean
): QaDeliveredCandidate[] {
  const { deliverK } = resolveQaDeliveryBudget(questionType);
  const deliveryPool =
    process.env.ALAYA_BENCH_QA_SESSION_SPREAD !== undefined
      ? selectSessionSpread(deliveryCandidates)
      : deliveryCandidates;
  return goldOnlyRequested
    ? goldOnly
    : shouldDedupQaDelivery()
      ? dedupeQaDeliveredCandidates(deliveryPool, deliverK)
      : deliveryPool.slice(0, deliverK);
}

// Agent-side LLM relevance filter: retrieve WIDE (catch precise-class gold
// buried at rank 12-15), let an LLM pick the few relevant memories, deliver
// NARROW clean context. Decouples retrieve-width from deliver-width — the
// semantic selection fusion ranking can't do. Default off.
async function applyQaLlmFilter(
  question: string,
  deliveryCandidates: readonly QaDeliveredCandidate[],
  delivered: QaDeliveredCandidate[],
  qaChat: QaChatFn
): Promise<QaDeliveredCandidate[]> {
  const filterK = readPositiveIntEnv("ALAYA_BENCH_QA_LLM_FILTER_K", 30);
  const filterM = readPositiveIntEnv("ALAYA_BENCH_QA_LLM_FILTER_M", 8);
  const widePool: QaDeliveredCandidate[] = shouldDedupQaDelivery()
    ? dedupeQaDeliveredCandidates(deliveryCandidates, filterK)
    : deliveryCandidates
        .filter((cand) => normalizeQaDeliveryContent(cand.content).length > 0)
        .slice(0, filterK);
  const selected = await selectRelevantMemories(question, widePool, filterM, qaChat);
  if (selected.length === 0) {
    return delivered;
  }
  return shouldDedupQaDelivery()
    ? dedupeQaDeliveredCandidates(selected, filterM)
    : selected.slice(0, filterM);
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
  if (input.qaChat === undefined) {
    return undefined;
  }
  const { delivered, memoryEntryCandidates } = await resolveQaDeliverySelection({
    question: input.question,
    qaChat: input.qaChat,
    results,
    goldMemoryIds,
    sidecar
  });
  const qaVerdict = await scoreQaQuestion(
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
  if (process.env.ALAYA_BENCH_QA_DUMP !== undefined) {
    dumpQaDeliveryDiagnostic({
      dumpPath: process.env.ALAYA_BENCH_QA_DUMP,
      question: input.question,
      qaVerdict,
      goldMemoryIds,
      memoryEntryCandidates,
      delivered
    });
  }
  return qaVerdict;
}
