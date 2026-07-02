import { z } from "zod";

// LoCoMo (Long-Conversation Memory) dataset by Snap Research, public
// release snap-research/locomo/data/locomo10.json: 10 conversations,
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
  .loose();
export type LocomoTurn = z.infer<typeof LocomoTurnSchema>;

const LocomoEvidenceSchema = z
  .array(z.string())
  .default([])
  .superRefine((rawEvidence, ctx) => {
    rawEvidence.forEach((rawRef, index) => {
      if (rawRef.trim().length === 0) {
        ctx.addIssue({
          code: "custom",
          message: "LoCoMo evidence refs must not be blank.",
          path: [index]
        });
        return;
      }
      const segments = rawRef.split(";").map((part) => part.trim());
      if (segments.some((part) => part.length === 0)) {
        ctx.addIssue({
          code: "custom",
          message: "LoCoMo evidence refs must not contain empty dia_id segments.",
          path: [index]
        });
      }
    });
  })
  .transform(normalizeLocomoEvidenceRefs);

export const LocomoQaSchema = z.object({
  question: z.string(),
  // invariant: the pinned LoCoMo fixture uses an empty/omitted answer as the
  // abstention marker. Most category-5 adversarial rows are answerless and use
  // `adversarial_answer` as the tempting wrong answer, but a small number of
  // category-5 rows carry an explicit gold answer (for example "No") and must
  // stay scoreable as factual QA. Normalize null/omitted answers to "" at the
  // schema boundary so the runner can classify abstention from the actual gold
  // answer field instead of a category heuristic.
  answer: z
    .union([z.string(), z.number(), z.null()])
    .optional()
    .transform((v) => (v === null || v === undefined ? "" : String(v))),
  // The pinned fixture is mostly one dia_id per element, but at least one QA
  // row ships a semicolon-joined multi-hop string (`"D8:6; D9:17"`). Split at
  // the schema boundary so every downstream caller sees normalized dia_ids
  // instead of re-implementing ad-hoc parsing in scoring code.
  evidence: LocomoEvidenceSchema,
  category: z.number().int(),
  adversarial_answer: z.string().optional()
}).superRefine((qa, ctx) => {
  if (qa.category !== 5 && qa.answer.trim().length === 0) {
    ctx.addIssue({
      code: "custom",
      message: "LoCoMo categories 1-4 must carry an explicit gold answer.",
      path: ["answer"]
    });
  }
  // The pinned fixture intentionally has four category-3 rows with no gold
  // evidence. All other categories are evidence-backed and should fail closed
  // if a future fixture drift would silently deflate retrieval denominators.
  if (qa.category !== 3 && qa.evidence.length === 0) {
    ctx.addIssue({
      code: "custom",
      message: "LoCoMo categories other than 3 must carry at least one evidence dia_id.",
      path: ["evidence"]
    });
  }
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

function normalizeLocomoEvidenceRefs(evidence: readonly string[]): string[] {
  return evidence.flatMap((rawRef) =>
    rawRef
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
  );
}
