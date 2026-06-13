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

const BENCH_PROFILE_ENV = "ALAYA_BENCH_PROFILE";

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
            ...(input.qaChat === undefined ? {} : { content: round.content })
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

    let qaVerdict: QaQuestionVerdict | undefined;
    if (input.qaChat !== undefined) {
      const delivered: QaDeliveredCandidate[] = deliveredResults
        .filter(
          (result) => (result.object_kind ?? "memory_entry") === "memory_entry"
        )
        .map((result) => ({
          objectId: result.object_id,
          content:
            sidecar.get(
              buildLongMemEvalSidecarKey("memory_entry", result.object_id)
            )?.content ?? ""
        }));
      qaVerdict = await scoreQaQuestion(
        {
          questionId: input.question.question_id,
          questionType: input.question.question_type,
          question: input.question.question,
          questionDate: input.question.question_date,
          goldAnswer: input.question.answer,
          delivered
        },
        input.qaChat
      );
    }

    const isAbstention = isAbstentionQuestionId(input.question.question_id);
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
