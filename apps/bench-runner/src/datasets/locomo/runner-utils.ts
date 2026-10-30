import { IsoDatetimeStringSchema, type ConversationMessage } from "@do-soul/alaya-protocol";
import { sourceStatementSession } from "../../runs/extraction/source-statement-request.js";
import { extractSessions, type LocomoQa, type LocomoSample, type LocomoTurn, type LocomoSession } from "./dataset.js";
import type { LocomoRunOptions } from "./runner-types.js";

// invariant: sample_size counts the retrieval denominator across the full
// dataset (every QA carrying non-empty evidence), not the number of
// conversations. Answerless adversarial rows still exercise retrieval when
// they point at gold evidence; abstention only changes the optional QA judge
// path. evaluated_count is the subset this run actually scored, so
// evaluated_count <= sample_size holds even when --limit slices the
// conversation window.
export function resolveLocomoSampleSize(
  conversations: readonly LocomoSample[]
): number {
  let total = 0;
  for (const conv of conversations) {
    for (const qa of conv.qa) {
      if (hasLocomoRetrievalEvidence(qa)) {
        total += 1;
      }
    }
  }
  return total;
}

// invariant: identical seed string at both call sites (live seed + extraction
// cache-key collection), else the extraction cache key mismatches and seeds
// diverge. Image turns splice blip_caption / query so the answer signal a
// deictic text ("take a look") drops is recoverable by lexical recall.
export function buildLocomoSeedContent(turn: LocomoTurn): string {
  const caption = turn.blip_caption?.trim() ?? "";
  const query = turn.query?.trim() ?? "";
  return [
    `${turn.speaker}: ${turn.text}`,
    caption.length > 0 ? `[image: ${caption}]` : "",
    query.length > 0 ? `[image query: ${query}]` : ""
  ]
    .filter((part) => part.length > 0)
    .join(" ");
}

/** Both named participants are humans; their original speaker names stay in source text.
 * Non-ISO session dates remain sidecar provenance, not invented timestamp precision.
 */
export function buildLocomoSessionMessages(session: LocomoSession): readonly ConversationMessage[] {
  const recorded = IsoDatetimeStringSchema.safeParse(session.date_time);
  return session.turns.map(turn => ({ message_id: turn.dia_id, role: "user", content: buildLocomoSeedContent(turn),
    ...(recorded.success ? { created_at: recorded.data } : {}) }));
}

export function collectLocomoExtractionSessions(conversations: readonly LocomoSample[]) {
  const sessions = new Map<string, { turnContent: string; turnMessages: readonly ConversationMessage[] }>();
  for (const conversation of conversations) for (const session of extractSessions(conversation.conversation)) {
    const turnMessages = buildLocomoSessionMessages(session);
    if (turnMessages.length === 0) continue;
    sessions.set(sourceStatementSession(turnMessages).sessionId, {
      turnContent: session.turns.map(buildLocomoSeedContent).join("\n"), turnMessages });
  }
  return [...sessions.values()];
}

export function hasLocomoRetrievalEvidence(qa: LocomoQa): boolean {
  return qa.evidence.length > 0;
}

export function isLocomoAbstentionQa(qa: LocomoQa): boolean {
  return qa.answer.trim().length === 0;
}

export function resolveLocomoQaGoldAnswer(qa: LocomoQa): string {
  if (!isLocomoAbstentionQa(qa)) {
    return qa.answer;
  }
  return "The conversation does not provide enough information to answer this question.";
}

export function shouldRunLocomoRecall(
  qa: LocomoQa,
  opts: LocomoRunOptions
): boolean {
  return hasLocomoRetrievalEvidence(qa) || opts.qa !== undefined;
}

export function resolveLocomoQaQuestionType(qa: LocomoQa): string {
  if (qa.category === 2) {
    return "temporal-reasoning";
  }
  if (qa.category === 3) {
    return "locomo-aggregation";
  }
  if (qa.category === 4) {
    return "locomo-open-domain";
  }
  return "locomo-factual";
}

export function readPositiveEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

export function buildLocomoQuestionId(sampleId: string, qaIndex: number): string {
  return `${sampleId}:${qaIndex + 1}`;
}

// LoCoMo gold evidence references phantom/malformed dia_ids that can never
// materialize; disclose the gap and score on present gold instead of failing closed.
export function resolveLocomoGoldMemoryIds(input: {
  readonly evidenceSet: ReadonlySet<string>;
  readonly memoryIdsByDiaId: ReadonlyMap<string, readonly string[]>;
}): { readonly goldMemoryIds: string[]; readonly missingDiaIds: string[] } {
  const goldMemoryIds: string[] = [];
  const missingDiaIds: string[] = [];
  for (const diaId of input.evidenceSet) {
    const memoryIds = input.memoryIdsByDiaId.get(diaId) ?? [];
    if (memoryIds.length === 0) {
      missingDiaIds.push(diaId);
      continue;
    }
    goldMemoryIds.push(...memoryIds);
  }
  return { goldMemoryIds, missingDiaIds };
}
