import { appendFileSync } from "node:fs";
import type {
  BenchEmbeddingMode,
  BenchEmbeddingProviderKind,
  BenchEmbeddingWarmupSummary,
  BenchQueryEmbeddingWarmupSummary,
  BenchRecallOptions,
  BenchTokenMetrics,
  BenchWorkspaceHandle,
  BenchDaemonHandle
} from "../harness/daemon.js";
import type { BenchRecallTokenEconomy } from "../harness/recall-diagnostics-schema.js";
import { extractRecallTokenEconomy } from "./recall-token-economy.js";
import type { EdgeProposalKpiEventRow } from "@do-soul/alaya-eval";
import type {
  LongMemEvalQuestionDiagnostic,
  LongMemEvalReportSideEffectSnapshot
} from "./diagnostics.js";
import { buildQuestionDiagnostic } from "./diagnostics.js";
import { isAbstentionQuestionId } from "./abstention.js";
import { pairSessionIntoRounds, type LongMemEvalQuestion } from "./dataset.js";
import {
  buildSessionSynthesisInput,
  computeNextTurnSeedRefs,
  type CompileSeedRunner,
  type SessionSeededTurn
} from "./compile-seed.js";
import {
  buildLongMemEvalSidecarKey,
  deriveLongMemEvalGoldMemoryIds,
  deriveLongMemEvalMemoryObjectIds,
  readLongMemEvalReportSideEffectSnapshot,
  resolveLongMemEvalHitVerdict,
  runLongMemEvalRecallCycle,
  type LongMemEvalReportSimulationStats,
  type LongMemEvalSidecarEntry
} from "./runner-helpers.js";
import {
  scoreQaQuestion,
  type QaDeliveredCandidate,
  type QaQuestionVerdict
} from "./qa-harness.js";
import type { LongMemEvalSnapshotQuestion } from "./snapshot.js";
import type { QaChatFn } from "./qa-chat.js";
import { selectRelevantMemories } from "./qa-llm-filter.js";

const BENCH_PROFILE_ENV = "ALAYA_BENCH_PROFILE";
const WIDE_QA_DELIVERY_QUESTION_TYPES = new Set([
  "knowledge-update",
  "multi-session"
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

function isBenchProfileEnabled(): boolean {
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

function createPhaseTimer(): PhaseTimer {
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

export interface LongMemEvalWorkerResult {
  readonly questionId: string;
  readonly hitAt1: boolean;
  readonly hitAt5: boolean;
  readonly hitAt10: boolean;
  readonly firstTier: "hot" | "warm" | "cold";
  readonly latencyMs: number;
  readonly degradationReason: string | null;
  readonly seedTurnsTruncated: number;
  readonly answerTurnsTruncated: number;
  readonly seedCharsClipped: number;
  readonly diagnostics: LongMemEvalQuestionDiagnostic;
  readonly embeddingWarmup: BenchEmbeddingWarmupSummary | null;
  readonly queryEmbeddingWarmup: BenchQueryEmbeddingWarmupSummary | null;
  readonly reportUsageStats: LongMemEvalReportSimulationStats;
  readonly reportSideEffectSnapshot: LongMemEvalReportSideEffectSnapshot;
  readonly tokenMetrics: BenchTokenMetrics;
  readonly recallTokenEconomy: BenchRecallTokenEconomy | null;
  readonly edgeProposalKpiRows: readonly EdgeProposalKpiEventRow[];
  readonly snapshotQuestion?: LongMemEvalSnapshotQuestion;
  readonly qaVerdict?: QaQuestionVerdict;
}

export async function runLongMemEvalQuestion(input: {
  readonly daemon: BenchDaemonHandle;
  readonly question: LongMemEvalQuestion;
  readonly turnIndex: number;
  readonly seedRunner: CompileSeedRunner;
  readonly recallOptions: BenchRecallOptions;
  readonly simulateReport: "none" | "gold-only" | "mixed" | "always-used";
  readonly embeddingMode: BenchEmbeddingMode;
  readonly embeddingProviderKind: BenchEmbeddingProviderKind;
  readonly captureSnapshot: boolean;
  readonly qaChat?: QaChatFn;
  readonly qaJudgeChat?: QaChatFn;
}): Promise<LongMemEvalWorkerResult> {
  const profileEnabled = isBenchProfileEnabled();
  const phase = createPhaseTimer();
  const tAttach = phase.tick();
  const workspace: BenchWorkspaceHandle = await input.daemon.attachWorkspace({
    workspaceId: `lme-${input.question.question_id.slice(0, 8)}`,
    runId: `run-${input.question.question_id.slice(0, 8)}`
  });
  phase.record("workspace_attach", tAttach);
  try {
    const tSeedLoop = phase.tick();
    const sidecar = new Map<string, LongMemEvalSidecarEntry>();
    const answerSessionSet = new Set(input.question.answer_session_ids);
    let seedTurnsTruncated = 0;
    let answerTurnsTruncated = 0;
    let seedCharsClipped = 0;

    let seedIndex = 0;
    const coherenceMembers: { memoryId: string; sessionId: string }[] = [];
    for (let si = 0; si < input.question.haystack_sessions.length; si++) {
      const session = input.question.haystack_sessions[si];
      const sessionId =
        input.question.haystack_session_ids[si] ?? `session-${si}`;
      if (session === undefined) continue;

      const rounds = pairSessionIntoRounds(session);
      const sessionTurns: SessionSeededTurn[] = [];
      const sessionMemberMemoryIds: string[] = [];
      let sessionHasAnswer = false;
      let previousTurnSeedMemoryIds: readonly string[] = [];
      for (let ri = 0; ri < rounds.length; ri++) {
        const round = rounds[ri];
        if (round === undefined) continue;

        const evidenceRef = `${input.question.question_id}-s${si}-r${ri}`;
        const seedResult = await input.seedRunner.seedTurn({
          daemon: workspace,
          turnContent: round.content,
          evidenceRefBase: evidenceRef,
          seedIndex,
          workspaceId: workspace.workspaceId,
          runId: workspace.runId,
          ...(previousTurnSeedMemoryIds.length === 0
            ? {}
            : { sourceMemoryRefs: previousTurnSeedMemoryIds })
        });
        seedIndex += 1;
        if (seedResult.turnTruncated) {
          seedTurnsTruncated += 1;
          seedCharsClipped += seedResult.charsClipped;
          if (round.hasAnswer) {
            answerTurnsTruncated += 1;
          }
        }
        if (round.hasAnswer) {
          sessionHasAnswer = true;
        }
        for (const seed of seedResult.seeds) {
          sidecar.set(buildLongMemEvalSidecarKey("memory_entry", seed.memoryId), {
            objectId: seed.memoryId,
            objectKind: "memory_entry",
            sessionId,
            hasAnswer: round.hasAnswer,
            // Carry content (+ event date) when QA is on OR a pool dump is
            // requested (offline rerank/coverage analysis needs candidate text +
            // event date). Off on both => omitted.
            ...(input.qaChat === undefined &&
            process.env.ALAYA_BENCH_POOL_DUMP === undefined
              ? {}
              : {
                  content: round.content,
                  ...(input.question.haystack_dates[si] === undefined
                    ? {}
                    : { eventDate: input.question.haystack_dates[si] })
                })
          });
          sessionTurns.push({
            turnContent: round.content,
            evidenceId: seed.evidenceId
          });
          sessionMemberMemoryIds.push(seed.memoryId);
          coherenceMembers.push({ memoryId: seed.memoryId, sessionId });
        }
        previousTurnSeedMemoryIds = computeNextTurnSeedRefs(seedResult);
      }

      await workspace.accrueSessionCoRecall(sessionMemberMemoryIds);

      const synthesisInput = buildSessionSynthesisInput({
        topicKey: `${input.question.question_id}-s${si}`,
        turns: sessionTurns
      });
      if (synthesisInput !== null) {
        const synthesisResult = await workspace.proposeSynthesis(synthesisInput);
        if (synthesisResult.synthesisId !== null) {
          sidecar.set(
            buildLongMemEvalSidecarKey(
              "synthesis_capsule",
              synthesisResult.synthesisId
            ),
            {
              objectId: synthesisResult.synthesisId,
              objectKind: "synthesis_capsule",
              sessionId,
              hasAnswer: sessionHasAnswer
            }
          );
        }
      }
    }

    phase.record("seed_loop", tSeedLoop);

    const tEmbeddingWarmup = phase.tick();
    const embeddingWarmup =
      input.embeddingMode === "env"
        ? await workspace.warmEmbeddingCache(
            deriveLongMemEvalMemoryObjectIds(sidecar)
          )
        : null;
    const queryEmbeddingWarmup =
      input.embeddingMode === "env"
        ? await workspace.warmQueryEmbeddingCache([input.question.question])
        : null;
    phase.record("embedding_warmup", tEmbeddingWarmup);

    const tEdgePlane = phase.tick();
    await input.daemon.runEdgePlanePassIfConfigured();
    phase.record("edge_plane", tEdgePlane);

    if (
      input.embeddingMode === "env" &&
      process.env.ALAYA_EXP_COHERENCE_EDGES === "1"
    ) {
      const coherenceSummary = await workspace.accrueCoherenceCoRecall(
        coherenceMembers,
        {
          floor: Number(process.env.ALAYA_EXP_COHERENCE_FLOOR ?? "0.6"),
          capPerNode: Number(process.env.ALAYA_EXP_COHERENCE_CAP ?? "3"),
          crossSessionOnly: process.env.ALAYA_EXP_COHERENCE_XSESSION !== "0"
        }
      );
      console.error(
        `[coherence-edges] q=${input.question.question_id} ` +
          `coherent=${coherenceSummary.coherentPairs} ` +
          `kept=${coherenceSummary.keptPairs} minted=${coherenceSummary.minted}`
      );
    }

    const goldMemoryIds = deriveLongMemEvalGoldMemoryIds(
      sidecar,
      answerSessionSet
    );

    const tRecall = phase.tick();
    const recallCycle = await runLongMemEvalRecallCycle({
      daemon: workspace,
      query: input.question.question,
      recallOptions: input.recallOptions,
      simulateReport: input.simulateReport,
      goldMemoryIds,
      turnIndex: input.turnIndex,
      questionText: input.question.question
    });
    phase.record("recall", tRecall);
    const recallResult = recallCycle.scoredRecallResult;
    const latencyMs = recallCycle.scoredRecallLatencyMs;
    const results = recallResult.results;
    const activeConstraintResults = (recallResult.active_constraints ?? []).map(
      (constraint, index) => ({
        object_id: constraint.object_id,
        rank: index + 1
      })
    );
    const deliveredResults = results.slice(0, 10).map((pointer, index) => ({
      object_id: pointer.object_id,
      object_kind: pointer.object_kind,
      rank: index + 1,
      relevance_score: pointer.relevance_score,
      score_factors: pointer.score_factors ?? null
    }));

    // Diagnostic: where do this question's gold memories rank in the full
    // (maxK-capped) recall list? Distinguishes "gold just past rank 10"
    // (coverage) from "gold missing entirely" (ranking miss). Default off.
    if (process.env.ALAYA_BENCH_GOLD_RANK_DUMP !== undefined) {
      const rankById = new Map(results.map((p, i) => [p.object_id, i + 1]));
      const ranks = goldMemoryIds
        .map((id) => rankById.get(id) ?? -1)
        .sort((a, b) => (a < 0 ? 1 : b < 0 ? -1 : a - b));
      const inK = ranks.filter((r) => r > 0).length;
      // Per gold session: the BEST (min) rank among its gold members. A session
      // with no ranked member (best=-1) has NO foothold in the candidate pool.
      const sessionBest = new Map<string, number>();
      for (const id of goldMemoryIds) {
        const sid =
          sidecar.get(buildLongMemEvalSidecarKey("memory_entry", id))?.sessionId ?? "?";
        const r = rankById.get(id) ?? -1;
        const cur = sessionBest.get(sid);
        if (cur === undefined || (r > 0 && (cur < 0 || r < cur))) sessionBest.set(sid, r);
      }
      const footholds = [...sessionBest.values()].filter((r) => r > 0).length;
      console.error(
        `[gold-rank] q=${input.question.question_id} sess=${input.question.answer_session_ids.length} ` +
          `gold=${goldMemoryIds.length} inK=${inK} ranks=[${ranks.join(",")}] ` +
          `sessFootholds=${footholds}/${sessionBest.size} ` +
          `sessBest=[${[...sessionBest.values()].sort((a, b) => (a < 0 ? 1 : b < 0 ? -1 : a - b)).join(",")}]`
      );
    }

    // Diagnostic: dump the FULL ranked candidate pool (content + gold flag +
    // event date + fusion rank) as JSONL for offline re-ranking experiments.
    // API-free (recall only). Default off; set ALAYA_BENCH_POOL_DUMP to a path.
    if (process.env.ALAYA_BENCH_POOL_DUMP !== undefined) {
      const goldSet = new Set(goldMemoryIds);
      // Per-candidate fusion breakdown (per-stream rank) from the core recall
      // diagnostics, for offline "which stream buries the gold" analysis.
      const fusionByOid = new Map<string, { fusedRank?: number; perStream?: unknown }>();
      const fb = (recallResult as { readonly diagnostics?: { readonly fusion_breakdown?: ReadonlyArray<{ readonly object_id: string; readonly fused_rank?: number; readonly per_stream_rank?: unknown }> } }).diagnostics?.fusion_breakdown;
      if (Array.isArray(fb)) {
        for (const b of fb) fusionByOid.set(b.object_id, { fusedRank: b.fused_rank, perStream: b.per_stream_rank });
      }
      const candidates = results.map((p, i) => {
        const kind = p.object_kind ?? "memory_entry";
        // memory_entry candidates key on "memory_entry"; synthesis_capsule (route-B
        // navigator) candidates carry their session via the capsule sidecar — resolve
        // it so offline route-B coverage sim can credit a capsule's whole session.
        const entry =
          sidecar.get(buildLongMemEvalSidecarKey("memory_entry", p.object_id)) ??
          sidecar.get(buildLongMemEvalSidecarKey("synthesis_capsule", p.object_id));
        const fusion = fusionByOid.get(p.object_id);
        return {
          rank: i + 1,
          objectId: p.object_id,
          objectKind: kind,
          isGold: goldSet.has(p.object_id),
          sessionId: entry?.sessionId ?? null,
          eventDate: entry?.eventDate ?? null,
          ...(fusion?.fusedRank === undefined ? {} : { fusedRank: fusion.fusedRank }),
          ...(fusion?.perStream === undefined ? {} : { perStream: fusion.perStream }),
          content: (entry?.content ?? "").replace(/\s+/gu, " ").slice(0, 400)
        };
      });
      // Full gold set with session + recalled flag, for offline coverage analysis.
      const recalledIds = new Set(results.map((p) => p.object_id));
      const goldMemories = goldMemoryIds.map((id) => {
        const entry = sidecar.get(buildLongMemEvalSidecarKey("memory_entry", id));
        return {
          objectId: id,
          sessionId: entry?.sessionId ?? null,
          recalled: recalledIds.has(id),
          content: (entry?.content ?? "").replace(/\s+/gu, " ").slice(0, 240)
        };
      });
      appendFileSync(
        process.env.ALAYA_BENCH_POOL_DUMP,
        JSON.stringify({
          questionId: input.question.question_id,
          questionType: input.question.question_type,
          question: input.question.question,
          questionDate: input.question.question_date,
          goldAnswer: input.question.answer,
          goldCount: goldMemoryIds.length,
          poolSize: results.length,
          goldMemories,
          candidates
        }) + "\n"
      );
    }

    const isAbstention = isAbstentionQuestionId(input.question.question_id);
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
      const memoryEntryResults = results.filter(
        (pointer) => (pointer.object_kind ?? "memory_entry") === "memory_entry"
      );
      const memoryEntryCandidates = memoryEntryResults.map((result) => {
        const entry = sidecar.get(
          buildLongMemEvalSidecarKey("memory_entry", result.object_id)
        );
        return {
          objectId: result.object_id,
          content: entry?.content ?? "",
          sessionId: entry?.sessionId ?? null,
          ...(entry?.eventDate === undefined ? {} : { eventDate: entry.eventDate })
        };
      });
      const goldOnlyRequested =
        process.env.ALAYA_BENCH_DELIVER_GOLD_ONLY !== undefined;
      const deliveryPool =
        process.env.ALAYA_BENCH_QA_SESSION_SPREAD !== undefined
          ? selectSessionSpread(memoryEntryCandidates)
          : memoryEntryCandidates;
      let delivered: QaDeliveredCandidate[] = goldOnlyRequested
        ? goldMemoryIds.map((id) => {
          const entry = sidecar.get(
            buildLongMemEvalSidecarKey("memory_entry", id)
          );
          return {
            objectId: id,
            content: entry?.content ?? "",
            ...(entry?.eventDate === undefined ? {} : { eventDate: entry.eventDate })
          };
        })
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
          ? dedupeQaDeliveredCandidates(memoryEntryCandidates, filterK)
          : memoryEntryCandidates
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
            deliveredGoldOnly:
              process.env.ALAYA_BENCH_DELIVER_GOLD_ONLY !== undefined,
            delivered: delivered.map((d) => ({
              objectId: d.objectId,
              ...(d.eventDate === undefined ? {} : { eventDate: d.eventDate }),
              content: d.content.replace(/\s+/gu, " ")
            }))
          }) + "\n"
        );
      }
    }

    const scoredHits = resolveLongMemEvalHitVerdict({
      isAbstention,
      results,
      sidecar,
      answerSessionIds: answerSessionSet
    });
    const diagnostics = buildQuestionDiagnostic({
      questionId: input.question.question_id,
      goldMemoryIds,
      answerSessionIds: input.question.answer_session_ids,
      deliveredResults,
      activeConstraintResults,
      hitAt1: scoredHits.hitAt1,
      hitAt5: scoredHits.hitAt5,
      hitAt10: scoredHits.hitAt10,
      isAbstention,
      degradationReason: recallResult.degradation_reason ?? null,
      recallResult,
      embeddingMode: input.embeddingMode
    });
    const tKpiQuery = phase.tick();
    const reportSideEffectSnapshot =
      await readLongMemEvalReportSideEffectSnapshot(
        input.question.question_id,
        input.daemon,
        workspace.workspaceId
      );
    const tokenMetrics = await workspace.queryTokenMetrics();
    const recallTokenEconomy = extractRecallTokenEconomy(recallResult);
    const edgeProposalKpiRows = await workspace.queryEdgeProposalKpiRows();
    phase.record("kpi_query", tKpiQuery);

    return {
      questionId: input.question.question_id,
      hitAt1: scoredHits.hitAt1,
      hitAt5: scoredHits.hitAt5,
      hitAt10: scoredHits.hitAt10,
      firstTier: scoredHits.firstTier,
      latencyMs,
      degradationReason: recallResult.degradation_reason ?? null,
      seedTurnsTruncated,
      answerTurnsTruncated,
      seedCharsClipped,
      diagnostics,
      embeddingWarmup,
      queryEmbeddingWarmup,
      reportUsageStats: recallCycle.reportUsageStats,
      reportSideEffectSnapshot,
      tokenMetrics,
      recallTokenEconomy,
      edgeProposalKpiRows,
      ...(qaVerdict === undefined ? {} : { qaVerdict }),
      ...(input.captureSnapshot
        ? {
            snapshotQuestion: {
              questionId: input.question.question_id,
              question: input.question.question,
              answerSessionIds: [...input.question.answer_session_ids],
              workspaceId: workspace.workspaceId,
              runId: workspace.runId,
              sidecar: [...sidecar.values()].map((entry) => ({
                objectId: entry.objectId,
                objectKind: entry.objectKind,
                sessionId: entry.sessionId,
                hasAnswer: entry.hasAnswer
              }))
            }
          }
        : {})
    };
  } finally {
    const tDetach = phase.tick();
    await workspace.detach();
    phase.record("workspace_detach", tDetach);
    if (profileEnabled) {
      process.stderr.write(
        `[bench_profile] question=${input.question.question_id} ${phase.format()}\n`
      );
    }
  }
}
