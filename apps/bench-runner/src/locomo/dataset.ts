import { z } from "zod";

// LoCoMo (Long-Conversation Memory) dataset by Snap Research, public
// release snap-research/locomo/data/locomo10.json — 10 conversations,
// 1986 QA pairs across 5 categories, ~5882 dialog turns total.
// see also: https://snap-research.github.io/locomo/
//          https://github.com/snap-research/locomo

export const LocomoTurnSchema = z
  .object({
    speaker: z.string(),
    dia_id: z.string(),
    text: z.string(),
    img_url: z.array(z.string()).optional(),
    blip_caption: z.string().optional(),
    query: z.string().optional()
  })
  .passthrough();
export type LocomoTurn = z.infer<typeof LocomoTurnSchema>;

export const LocomoQaSchema = z.object({
  question: z.string(),
  answer: z.union([z.string(), z.number()]).transform((v) => String(v)),
  evidence: z.array(z.string()).default([]),
  category: z.number().int(),
  adversarial_answer: z.string().optional()
});
export type LocomoQa = z.infer<typeof LocomoQaSchema>;

const LocomoConversationBodySchema = z
  .object({
    speaker_a: z.string(),
    speaker_b: z.string()
  })
  .catchall(z.union([z.string(), z.array(LocomoTurnSchema)]));
export type LocomoConversationBody = z.infer<typeof LocomoConversationBodySchema>;

export const LocomoSampleSchema = z.object({
  sample_id: z.string(),
  conversation: LocomoConversationBodySchema,
  qa: z.array(LocomoQaSchema),
  event_summary: z.unknown().optional(),
  observation: z.unknown().optional(),
  session_summary: z.unknown().optional()
});
export type LocomoSample = z.infer<typeof LocomoSampleSchema>;

export const LocomoVariant = z.enum(["locomo10"]);
export type LocomoVariant = z.infer<typeof LocomoVariant>;

export interface LocomoSession {
  readonly session_id: string;
  readonly date_time: string | null;
  readonly turns: readonly LocomoTurn[];
}

export function extractSessions(body: LocomoConversationBody): readonly LocomoSession[] {
  const sessions = new Map<string, { date_time: string | null; turns: LocomoTurn[] }>();
  for (const key of Object.keys(body)) {
    if (key === "speaker_a" || key === "speaker_b") continue;
    const match = key.match(/^session_(\d+)(_date_time)?$/);
    if (match === null) continue;
    const sessionId = `session_${match[1]}`;
    const isDate = match[2] === "_date_time";
    const value = body[key as keyof LocomoConversationBody];
    const entry = sessions.get(sessionId) ?? { date_time: null, turns: [] };
    if (isDate) {
      entry.date_time = typeof value === "string" ? value : null;
    } else if (Array.isArray(value)) {
      entry.turns = value as LocomoTurn[];
    }
    sessions.set(sessionId, entry);
  }
  return [...sessions.entries()]
    .map(([id, entry]) => ({ session_id: id, date_time: entry.date_time, turns: entry.turns }))
    .sort((left, right) => sessionOrdinal(left.session_id) - sessionOrdinal(right.session_id));
}

function sessionOrdinal(sessionId: string): number {
  const match = sessionId.match(/_(\d+)$/);
  if (match === null) return Number.MAX_SAFE_INTEGER;
  return Number(match[1]);
}
