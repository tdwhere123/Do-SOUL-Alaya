import { byteIntervalsCoverSpan, type MessageByteInterval } from "./message-visibility.js";
import type { AnswerTurnGold, AnswerTurnSpan } from "./answer-spans.js";
import type { SourceGoldUnit } from "../measurement/source-gold-join.js";

export const RECALL_VISIBILITY_DIAGNOSTICS_CONTRACT = "recall-visibility-diagnostics-v1" as const;

export interface DeliveredIntervalSlot {
  readonly slot: number;
  readonly target: SourceGoldUnit;
  readonly span: {
    readonly content_start: number;
    readonly content_end: number;
  };
}

export interface ContiguousReadMetric {
  readonly any: boolean;
  readonly all: boolean;
  readonly status: "hit" | "miss" | "unknown";
  readonly reason: string | null;
  readonly covered: number;
  readonly total: number;
}

export interface MessageContiguousDiagnostic {
  readonly session_index: number;
  readonly message_index: number;
  readonly source_id: string;
  readonly target: SourceGoldUnit;
  readonly start: number;
  readonly end: number;
  readonly text_chunk_match: boolean;
  readonly at5: boolean;
  readonly at10: boolean;
  readonly b2048: boolean;
  readonly b4096: boolean;
  readonly b8192: boolean;
  readonly joining_intervals: readonly { readonly slot: number; readonly start: number; readonly end: number }[];
}

export interface RecallVisibilityDiagnostics {
  readonly read_gold: {
    readonly annotated: number;
    readonly mapped: number;
    readonly complete: boolean;
  };
  readonly read5: ContiguousReadMetric;
  readonly read10: ContiguousReadMetric;
  readonly read_b2048: ContiguousReadMetric;
  readonly read_b4096: ContiguousReadMetric;
  readonly read_b8192: ContiguousReadMetric;
  readonly source_diagnostics: {
    readonly contract: typeof RECALL_VISIBILITY_DIAGNOSTICS_CONTRACT;
    readonly messages: readonly MessageContiguousDiagnostic[];
    readonly reason?: string | null;
  };
}

/** Full source identity join. Intervals never merge across root, workspace, version or digest. */
export function sourceTargetsJoinGold(target: SourceGoldUnit, goldTarget: SourceGoldUnit): boolean {
  return target.workspace_id === goldTarget.workspace_id
    && target.root_kind === goldTarget.root_kind
    && target.root_id === goldTarget.root_id
    && target.source_version === goldTarget.source_version
    && target.content_digest === goldTarget.content_digest;
}

/** Clips partial intervals in slot order by budget allowance; charged repeated bytes are not invisibly deduped. */
export function clipDeliveredSlotsByBudget(
  slots: readonly DeliveredIntervalSlot[],
  budget: number
): readonly DeliveredIntervalSlot[] {
  let left = budget;
  const result: DeliveredIntervalSlot[] = [];
  for (const s of slots) {
    if (left <= 0) break;
    const len = s.span.content_end - s.span.content_start;
    if (len <= 0) continue;
    const charge = Math.min(len, left);
    left -= charge;
    result.push({
      slot: s.slot,
      target: s.target,
      span: {
        content_start: s.span.content_start,
        content_end: s.span.content_start + charge
      }
    });
  }
  return result;
}

/** Tests whether delivered intervals matching the gold span's exact identity cover its span with no gaps. */
export function spanIsCoveredByIntervals(
  intervals: readonly DeliveredIntervalSlot[],
  span: AnswerTurnSpan
): boolean {
  const matching = intervals.filter(i => sourceTargetsJoinGold(i.target, span.target));
  const byteIntervals: MessageByteInterval[] = matching.map(i => ({
    start: i.span.content_start,
    end: i.span.content_end
  }));
  return byteIntervalsCoverSpan(byteIntervals, { start: span.start, end: span.end });
}

function buildContiguousMetric(
  coverage: readonly boolean[],
  gold: AnswerTurnGold,
  unavailableReason: string | null = null
): ContiguousReadMetric {
  const covered = coverage.filter(Boolean).length;
  const total = gold.annotated_turns;
  if (unavailableReason !== null) {
    return { any: false, all: false, status: "unknown", reason: unavailableReason, covered: 0, total };
  }
  if (!gold.complete) {
    return {
      any: covered > 0,
      all: false,
      status: "unknown",
      reason: "answer_turn_mapping_incomplete",
      covered,
      total
    };
  }
  const any = covered > 0;
  const all = total > 0 && covered === total;
  return {
    any,
    all,
    status: all ? "hit" : any ? "hit" : "miss",
    reason: null,
    covered,
    total
  };
}

export function scoreContiguousReadVisibility(input: {
  readonly gold: AnswerTurnGold;
  readonly slots: readonly DeliveredIntervalSlot[];
  readonly textChunkMatches?: readonly boolean[];
  readonly budgets?: readonly number[];
}): RecallVisibilityDiagnostics {
  const { gold, slots, textChunkMatches = [] } = input;
  const at5Slots = slots.filter(s => s.slot < 5);
  const at10Slots = slots.filter(s => s.slot < 10);
  const b2048Slots = clipDeliveredSlotsByBudget(slots, 2048);
  const b4096Slots = clipDeliveredSlotsByBudget(slots, 4096);
  const b8192Slots = clipDeliveredSlotsByBudget(slots, 8192);

  const at5Covered = gold.spans.map(s => spanIsCoveredByIntervals(at5Slots, s));
  const at10Covered = gold.spans.map(s => spanIsCoveredByIntervals(at10Slots, s));
  const b2048Covered = gold.spans.map(s => spanIsCoveredByIntervals(b2048Slots, s));
  const b4096Covered = gold.spans.map(s => spanIsCoveredByIntervals(b4096Slots, s));
  const b8192Covered = gold.spans.map(s => spanIsCoveredByIntervals(b8192Slots, s));

  const messages: MessageContiguousDiagnostic[] = gold.spans.map((span, index) => {
    const joining = slots.filter(s => sourceTargetsJoinGold(s.target, span.target));
    return {
      session_index: span.session_index,
      message_index: span.message_index,
      source_id: span.source_id,
      target: span.target,
      start: span.start,
      end: span.end,
      text_chunk_match: textChunkMatches[index] ?? false,
      at5: at5Covered[index] ?? false,
      at10: at10Covered[index] ?? false,
      b2048: b2048Covered[index] ?? false,
      b4096: b4096Covered[index] ?? false,
      b8192: b8192Covered[index] ?? false,
      joining_intervals: joining.map(i => ({
        slot: i.slot,
        start: i.span.content_start,
        end: i.span.content_end
      }))
    };
  });

  return {
    read_gold: {
      annotated: gold.annotated_turns,
      mapped: gold.spans.length,
      complete: gold.complete
    },
    read5: buildContiguousMetric(at5Covered, gold),
    read10: buildContiguousMetric(at10Covered, gold),
    read_b2048: buildContiguousMetric(b2048Covered, gold),
    read_b4096: buildContiguousMetric(b4096Covered, gold),
    read_b8192: buildContiguousMetric(b8192Covered, gold),
    source_diagnostics: {
      contract: RECALL_VISIBILITY_DIAGNOSTICS_CONTRACT,
      messages
    }
  };
}

export function unavailableRecallRowDiagnostics(
  reason: string,
  annotatedTurns = 0
): RecallVisibilityDiagnostics {
  const unavail: ContiguousReadMetric = {
    any: false,
    all: false,
    status: "unknown",
    reason,
    covered: 0,
    total: annotatedTurns
  };
  return {
    read_gold: { annotated: annotatedTurns, mapped: 0, complete: false },
    read5: unavail,
    read10: unavail,
    read_b2048: unavail,
    read_b4096: unavail,
    read_b8192: unavail,
    source_diagnostics: {
      contract: RECALL_VISIBILITY_DIAGNOSTICS_CONTRACT,
      messages: [],
      reason
    }
  };
}
