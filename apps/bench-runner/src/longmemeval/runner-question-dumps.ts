import { appendFileSync } from "node:fs";
import {
  buildLongMemEvalSidecarKey,
  type LongMemEvalSidecarEntry
} from "./runner-helpers.js";
import type { LongMemEvalQuestion } from "./dataset.js";

type RecallResult = {
  readonly results: readonly {
    readonly object_id: string;
    readonly object_kind?: string;
  }[];
  readonly diagnostics?: unknown;
};

export function writeQuestionDiagnosticDumps(input: {
  readonly question: LongMemEvalQuestion;
  readonly goldMemoryIds: readonly string[];
  readonly sidecar: ReadonlyMap<string, LongMemEvalSidecarEntry>;
  readonly recallResult: RecallResult;
}): void {
  writeGoldRankDumpIfEnabled(input);
  writePoolDumpIfEnabled(input);
}

function writeGoldRankDumpIfEnabled(input: Parameters<typeof writeQuestionDiagnosticDumps>[0]): void {
  if (process.env.ALAYA_BENCH_GOLD_RANK_DUMP === undefined) return;
  const rankById = new Map(input.recallResult.results.map((p, i) => [p.object_id, i + 1]));
  const ranks = input.goldMemoryIds
    .map((id) => rankById.get(id) ?? -1)
    .sort((a, b) => (a < 0 ? 1 : b < 0 ? -1 : a - b));
  const sessionBest = buildSessionBestRanks(input, rankById);
  const footholds = [...sessionBest.values()].filter((r) => r > 0).length;
  console.error(
    `[gold-rank] q=${input.question.question_id} sess=${input.question.answer_session_ids.length} ` +
      `gold=${input.goldMemoryIds.length} inK=${ranks.filter((r) => r > 0).length} ` +
      `ranks=[${ranks.join(",")}] sessFootholds=${footholds}/${sessionBest.size} ` +
      `sessBest=[${[...sessionBest.values()].sort((a, b) => (a < 0 ? 1 : b < 0 ? -1 : a - b)).join(",")}]`
  );
}

function buildSessionBestRanks(
  input: Parameters<typeof writeQuestionDiagnosticDumps>[0],
  rankById: ReadonlyMap<string, number>
): Map<string, number> {
  const sessionBest = new Map<string, number>();
  for (const id of input.goldMemoryIds) {
    const sid = input.sidecar.get(buildLongMemEvalSidecarKey("memory_entry", id))?.sessionId ?? "?";
    const rank = rankById.get(id) ?? -1;
    const current = sessionBest.get(sid);
    if (current === undefined || (rank > 0 && (current < 0 || rank < current))) {
      sessionBest.set(sid, rank);
    }
  }
  return sessionBest;
}

function writePoolDumpIfEnabled(input: Parameters<typeof writeQuestionDiagnosticDumps>[0]): void {
  const dumpPath = process.env.ALAYA_BENCH_POOL_DUMP;
  if (dumpPath === undefined) return;
  const candidates = buildPoolDumpCandidates(input);
  const recalledIds = new Set(input.recallResult.results.map((p) => p.object_id));
  const goldMemories = input.goldMemoryIds.map((id) => {
    const entry = input.sidecar.get(buildLongMemEvalSidecarKey("memory_entry", id));
    return {
      objectId: id,
      sessionId: entry?.sessionId ?? null,
      recalled: recalledIds.has(id),
      content: (entry?.content ?? "").replace(/\s+/gu, " ").slice(0, 240)
    };
  });
  appendFileSync(dumpPath, JSON.stringify({
    questionId: input.question.question_id,
    questionType: input.question.question_type,
    question: input.question.question,
    questionDate: input.question.question_date,
    goldAnswer: input.question.answer,
    goldCount: input.goldMemoryIds.length,
    poolSize: input.recallResult.results.length,
    goldMemories,
    candidates
  }) + "\n");
}

function buildPoolDumpCandidates(input: Parameters<typeof writeQuestionDiagnosticDumps>[0]) {
  const goldSet = new Set(input.goldMemoryIds);
  const fusionByOid = readFusionBreakdown(input.recallResult);
  return input.recallResult.results.map((pointer, index) => {
    const entry =
      input.sidecar.get(buildLongMemEvalSidecarKey("memory_entry", pointer.object_id)) ??
      input.sidecar.get(buildLongMemEvalSidecarKey("synthesis_capsule", pointer.object_id));
    const fusion = fusionByOid.get(pointer.object_id);
    return {
      rank: index + 1,
      objectId: pointer.object_id,
      objectKind: pointer.object_kind ?? "memory_entry",
      isGold: goldSet.has(pointer.object_id),
      sessionId: entry?.sessionId ?? null,
      eventDate: entry?.eventDate ?? null,
      ...(fusion?.fusedRank === undefined ? {} : { fusedRank: fusion.fusedRank }),
      ...(fusion?.perStream === undefined ? {} : { perStream: fusion.perStream }),
      content: (entry?.content ?? "").replace(/\s+/gu, " ").slice(0, 400)
    };
  });
}

function readFusionBreakdown(
  recallResult: RecallResult
): Map<string, { readonly fusedRank?: number; readonly perStream?: unknown }> {
  const fusion = new Map<string, { readonly fusedRank?: number; readonly perStream?: unknown }>();
  const breakdown = (recallResult as {
    readonly diagnostics?: {
      readonly fusion_breakdown?: ReadonlyArray<{
        readonly object_id: string;
        readonly fused_rank?: number;
        readonly per_stream_rank?: unknown;
      }>;
    };
  }).diagnostics?.fusion_breakdown;
  if (Array.isArray(breakdown)) {
    for (const item of breakdown) {
      fusion.set(item.object_id, {
        fusedRank: item.fused_rank,
        perStream: item.per_stream_rank
      });
    }
  }
  return fusion;
}
