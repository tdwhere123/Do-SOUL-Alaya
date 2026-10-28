import type { QaDeliveredCandidate } from "./qa-harness.js";

export interface QaContextExposure {
  readonly objectId: string;
  readonly objectKind: string;
  readonly contentChars: number;
  readonly includedContentChars: number;
}

/** Record the exact selected content exposed after applying the prompt cap. */
export function buildQaAnswerContextReceipt(delivered: readonly QaDeliveredCandidate[]) {
  const raw = Number(process.env.ALAYA_BENCH_QA_CONTEXT_CHARS);
  const cap = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 60_000;
  const exposures: QaContextExposure[] = [];
  let text = "";
  for (const [index, candidate] of delivered.filter((item) => item.content.length > 0).entries()) {
    const parts = [`Memory ${index + 1}`];
    if (candidate.eventDate !== undefined && candidate.eventDate.length > 0) parts.push(`recorded=${candidate.eventDate}`);
    if (typeof candidate.sessionId === "string" && candidate.sessionId.length > 0) parts.push(`session=${candidate.sessionId}`);
    parts.push(`rank=${candidate.sourceRank ?? index + 1}`);
    text += `${index === 0 ? "" : "\n\n"}[${parts.join(" | ")}]\n`;
    exposures.push({ objectId: candidate.objectId, objectKind: candidate.objectKind ?? "memory_entry",
      contentChars: candidate.content.length,
      includedContentChars: Math.max(0, Math.min(candidate.content.length, cap - text.length)) });
    text += candidate.content;
  }
  return { context: text.slice(0, cap), exposures, clipped: text.length > cap };
}

export function buildQaAnswerContext(delivered: readonly QaDeliveredCandidate[]): string {
  return buildQaAnswerContextReceipt(delivered).context;
}
