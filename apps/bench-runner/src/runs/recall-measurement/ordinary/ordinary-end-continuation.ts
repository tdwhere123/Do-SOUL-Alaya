import {
  AlayaError, SoulMemorySearchResponseSchema, type RecallTargetRef, type SoulMemorySearchResponse
} from "@do-soul/alaya-protocol";
import { refuseBenchWorkAfterCancel } from "../../../harness/daemon-task.js";
import { callMcpTool, readBenchMcpToolOutput, type BenchMcpToolCapture } from "../../../harness/daemon/runtime/daemon-mcp-support.js";
import type { BenchDaemonHandle } from "../../../harness/daemon.js";
import {
  ORDINARY_END_CONTINUATION_CALL_LIMIT, type OrdinaryEndContinuation, type OrdinaryRecallQueryRow
} from "./ordinary-entry-contract.js";

type Target = RecallTargetRef;
type Interval = OrdinaryRecallQueryRow["source_intervals"][number];
type Span = NonNullable<Interval["span"]>;
type Continued = OrdinaryEndContinuation["continuations"][number];

const sameRoot = (a: Target, b: Target) => a.kind === "source_evidence" && b.kind === "source_evidence"
  && a.root_id === b.root_id && a.source_version === b.source_version;

/**
 * Reads every cut slot of the finished membership window on from its delivered end, in slot
 * order, through public `payload_continuation` under the window's live continuation; a slot that
 * opened mid-root then reads its prefix, so every slot ends with its whole body. Membership is not
 * re-read and no slot is chosen by query-time judgment.
 */
export async function readCutSlotsAtEnd(daemon: BenchDaemonHandle, row: OrdinaryRecallQueryRow): Promise<OrdinaryEndContinuation> {
  const slots = cutSlots(row);
  const record: OrdinaryEndContinuation = {
    cut_slots: slots.length, completed_slots: 0, payload_calls: 0, continuations: [], issues: [], latency_ms: 0
  };
  const first = row.pages[0]?.request;
  const live = row.pages.at(-1)?.output?.index?.continuation ?? null;
  if (first === undefined || live === null) {
    if (slots.length > 0) record.issues.push("no live continuation after membership");
    return record;
  }
  const started = performance.now();
  for (const slot of slots) {
    let end = slot.span.content_end, forward = slot.span.content_complete;
    for (let call = 0; !forward && call < ORDINARY_END_CONTINUATION_CALL_LIMIT; call += 1) {
      refuseBenchWorkAfterCancel();
      const { continuation: _membership, ...initial } = first;
      const recalled = await recall(daemon, { ...initial, continuation: live, payload_continuation: {
        schema_version: 1, purpose: "payload_expansion", target: slot.entry, start_offset: end } });
      record.payload_calls += 1;
      if ("error" in recalled) { record.issues.push(`slot ${slot.slot_index} @${end}: ${recalled.error}`); break; }
      const got = recalled.output.results.find(result => sameRoot(result.target, slot.target));
      const span = got?.target.kind === "source_evidence" ? got.target.span : undefined;
      if (got === undefined || span === undefined || span.content_end <= end) {
        record.issues.push(`slot ${slot.slot_index} @${end}: no progress`); break;
      }
      record.continuations.push({ slot_index: slot.slot_index, target: got.target, span });
      end = span.content_end;
      if (span.content_complete) forward = true;
    }
    const opened = slot.span.content_start;
    let prefix = 0;
    for (let call = 0; forward && prefix < opened && call < ORDINARY_END_CONTINUATION_CALL_LIMIT; call += 1) {
      refuseBenchWorkAfterCancel();
      const { continuation: _membership, ...initial } = first;
      const recalled = await recall(daemon, { ...initial, continuation: live, payload_continuation: {
        schema_version: 1, purpose: "payload_expansion", target: slot.entry, start_offset: prefix, end_offset: opened } });
      record.payload_calls += 1;
      if ("error" in recalled) { record.issues.push(`slot ${slot.slot_index} prefix @${prefix}: ${recalled.error}`); break; }
      const got = recalled.output.results.find(result => sameRoot(result.target, slot.target));
      const span = got?.target.kind === "source_evidence" ? got.target.span : undefined;
      if (got === undefined || span === undefined || span.content_start !== prefix || span.content_end <= prefix || span.content_end > opened) {
        record.issues.push(`slot ${slot.slot_index} prefix @${prefix}: no progress`); break;
      }
      record.continuations.push({ slot_index: slot.slot_index, target: got.target, span, part: "prefix" });
      prefix = span.content_end;
    }
    if (forward && prefix >= opened) record.completed_slots += 1;
  }
  record.latency_ms = performance.now() - started;
  return record;
}

/** Cut slots with absolute indices and the index-entry target their page issued for them. */
function cutSlots(row: OrdinaryRecallQueryRow): { slot_index: number; target: Target; entry: Target; span: Span }[] {
  const slots: { slot_index: number; target: Target; entry: Target; span: Span }[] = [];
  if (row.first_exposure?.initial == null) return slots;
  let occupied = 0;
  for (const page of row.pages) {
    if (page.observation !== "observed") continue;
    const entries = page.output?.index?.entries ?? [];
    for (const interval of page.source_intervals) {
      if (interval.span === null || interval.span.content_complete && interval.span.content_start === 0) continue;
      const entry = entries.find(candidate => sameRoot(candidate.target, interval.target))?.target ?? interval.target;
      slots.push({ slot_index: occupied + interval.slot_index, target: interval.target, entry, span: interval.span });
    }
    occupied += page.occupied_slots;
  }
  return slots;
}

async function recall(daemon: BenchDaemonHandle, request: Record<string, unknown>):
  Promise<{ output: SoulMemorySearchResponse } | { error: string }> {
  let frame: BenchMcpToolCapture | undefined;
  try {
    await callMcpTool(daemon.mcpClient, "soul.recall", JSON.parse(JSON.stringify(request)) as Record<string, unknown>,
      captured => { frame = captured; });
  } catch (error) {
    if (error instanceof AlayaError && error.code === "CANCELLED") throw error;
    return { error: error instanceof Error ? error.message : String(error) };
  }
  if (frame === undefined) return { error: "no frame" };
  const response = frame.response as { isError?: unknown } | undefined;
  if (response?.isError === true) return { error: JSON.stringify(response).slice(0, 400) };
  const parsed = SoulMemorySearchResponseSchema.safeParse(readBenchMcpToolOutput("soul.recall", frame.response));
  return parsed.success ? { output: parsed.data } : { error: "invalid soul.recall output" };
}

/**
 * Scored reading order of the end-continuation reader: the delivered slots, where a slot cut inside the
 * witness range it opened at reads on to that range's end before the next slot; then each continued
 * slot's rest re-read from the last message end at or before where it resumes (conservative bytes),
 * followed by its whole prefix when the slot opened mid-root.
 */
export function endContinuationReading(intervals: readonly Interval[], record: OrdinaryEndContinuation,
  messageEnds: (rootId: string) => readonly number[]): {
    intervals: Interval[]; cut: number; completed: number; initial_bytes: number; continuation_bytes: number;
  } {
  const first: Interval[] = [], extra: Interval[] = [];
  let cut = 0, completed = 0, initial = 0, continued = 0;
  const from = (interval: Interval & { span: NonNullable<Interval["span"]> }, at: number) => Math.max(interval.span.content_start,
    interval.target.kind === "source_evidence" ? messageEnds(interval.target.root_id).filter(end => end <= at).at(-1) ?? 0 : 0);
  for (const interval of intervals) {
    first.push(interval);
    if (interval.span === null) continue;
    initial += interval.span.content_end - interval.span.content_start;
    if (interval.target.kind !== "source_evidence") continue;
    const parts = record.continuations.filter(part => part.slot_index === interval.slot_index);
    if (!interval.span.content_complete) {
      cut += 1;
      const last = parts.filter(part => part.part === undefined).at(-1)?.span;
      if (last !== undefined) {
        if (last.content_complete) completed += 1;
        let resume = interval.span.content_end;
        const unit = interval.opening_end;
        if (unit !== undefined && unit > resume && unit <= last.content_end) {
          const start = from(interval as Interval & { span: NonNullable<Interval["span"]> }, resume);
          const span = { ...last, content_start: start, content_end: unit, content_complete: unit === last.content_end };
          continued += unit - start;
          first.push({ slot_index: interval.slot_index, target: { ...interval.target, span }, span });
          resume = unit;
        }
        if (resume < last.content_end) {
          const start = unit !== undefined && resume === unit ? unit : from(interval as Interval & { span: NonNullable<Interval["span"]> }, resume);
          continued += last.content_end - start;
          const span = { ...last, content_start: start };
          extra.push({ slot_index: interval.slot_index, target: { ...interval.target, span }, span });
        }
      }
    }
    // The prefix is read contiguously from byte 0, so it is scored as one span.
    const prefix = parts.filter(part => part.part === "prefix").at(-1)?.span;
    if (prefix !== undefined) {
      continued += prefix.content_end;
      const span = { ...prefix, content_start: 0 };
      extra.push({ slot_index: interval.slot_index, target: { ...interval.target, span }, span });
    }
  }
  return { intervals: [...first, ...extra], cut, completed, initial_bytes: initial, continuation_bytes: continued };
}
