/**
 * @anchor longmemeval-qa-llm-filter — agent-side semantic relevance filter.
 *
 * The recall §D wall: precise-class gold (temporal/preference) and its
 * co-topical distractors are lexical/embedding neighbours, so fusion ranking
 * cannot separate them — but a reading LLM CAN (it knows an "Adobe Premiere"
 * preference answers a "video-editing resources" request). Per the invariant
 * "reranking is the consuming agent's job" this selection belongs to the
 * consuming agent, not the recall fusion layer. This module models that step:
 * retrieve WIDE (catch gold buried at rank 12-15), then let an LLM pick the few
 * relevant memories, so the answer model reads a NARROW clean context (wide
 * delivery dilutes precise types — delivery-budget-per-question-type).
 *
 * Generic and question-type-agnostic on purpose (no per-category prompt = no
 * benchmark fitting). Off by default; a parse failure falls back to the natural
 * delivery so a flaky filter call never zeroes a question.
 *
 * see also: apps/bench-runner/src/longmemeval/qa-harness.ts — answer/judge flow
 * see also: apps/bench-runner/src/longmemeval/runner-question.ts — wiring
 */
import type { QaChatFn } from "./qa-chat.js";
import type { QaDeliveredCandidate } from "./qa-harness.js";

/** Chars of each candidate shown to the filter (enough to judge relevance; the
 * full content is still what gets delivered to the answer model). */
const FILTER_PREVIEW_CHARS = 500;

const FILTER_SYSTEM =
  "You select which stored memories a question-answering assistant should read " +
  "to answer a user's question. You see a numbered list of candidate memories " +
  "and the question. Reply with ONLY the numbers of the memories relevant to " +
  "answering it, comma-separated, most relevant first. Include a memory if it " +
  "could hold the answer, a component of the answer, or context needed to " +
  "compute it (e.g. a date, a preference, a related event). Exclude clearly " +
  "unrelated memories. When in doubt, include it. Reply with numbers only, no prose.";

/** Build the filter user prompt: question + numbered candidate previews. */
export function buildFilterUserPrompt(
  question: string,
  candidates: readonly QaDeliveredCandidate[],
  maxSelect: number
): string {
  const lines = candidates.map((cand, i) => {
    const preview = cand.content.replace(/\s+/gu, " ").slice(0, FILTER_PREVIEW_CHARS);
    const date = cand.eventDate !== undefined && cand.eventDate.length > 0 ? `(${cand.eventDate}) ` : "";
    return `[${i + 1}] ${date}${preview}`;
  });
  return (
    `Question: ${question}\n\n` +
    `Candidate memories:\n${lines.join("\n")}\n\n` +
    `Return the numbers of up to ${maxSelect} memories relevant to answering the question, comma-separated, most relevant first.`
  );
}

/**
 * Parse the filter verdict ("3, 1, 7" / "[3], [1]" / "1 and 4") into 0-based
 * candidate indices, in reply order, deduped, dropping out-of-range numbers,
 * capped at maxSelect. Returns [] when nothing parses (caller falls back).
 */
export function parseFilterSelection(
  verdict: string,
  candidateCount: number,
  maxSelect: number
): number[] {
  const nums = verdict.match(/\d+/gu);
  if (nums === null) return [];
  const seen = new Set<number>();
  const out: number[] = [];
  for (const raw of nums) {
    const idx = Number.parseInt(raw, 10) - 1;
    if (idx < 0 || idx >= candidateCount || seen.has(idx)) continue;
    seen.add(idx);
    out.push(idx);
    if (out.length >= maxSelect) break;
  }
  return out;
}

/**
 * Run the LLM relevance filter over a wide candidate pool, returning the
 * selected candidates (full content preserved) in the filter's relevance order.
 * Returns [] on empty input or an unparseable verdict so the caller can fall
 * back to its natural delivery.
 */
export async function selectRelevantMemories(
  question: string,
  candidates: readonly QaDeliveredCandidate[],
  maxSelect: number,
  chat: QaChatFn
): Promise<QaDeliveredCandidate[]> {
  if (candidates.length === 0 || maxSelect <= 0) return [];
  const verdict = await chat(
    FILTER_SYSTEM,
    buildFilterUserPrompt(question, candidates, maxSelect)
  );
  const picks = parseFilterSelection(verdict, candidates.length, maxSelect);
  return picks.map((idx) => candidates[idx]!).filter((c) => c.content.length > 0);
}
