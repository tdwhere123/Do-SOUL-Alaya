import { createHash } from "node:crypto";
import { z } from "zod";
import { QUESTION_TIME_PROPOSAL_PRODUCER_ID, SOURCE_TEMPLATE_PROPOSAL_PRODUCER_ID,
  EvidenceConditionSchema, QuestionTimePreferenceSchema, QueryInterpretationProposalSchema,
  type QueryInterpretationProposal } from "@do-soul/alaya-protocol";

const CoordinateEnvelope = z.looseObject({ status: z.string(), coordinates: z.unknown().optional() });
const Coordinates = z.looseObject({ time: z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("absent"), alternatives: z.array(z.unknown()).length(0).optional() }),
  z.object({ kind: z.literal("window"), alternatives: z.array(z.object({ start: z.string(), end: z.string() })).readonly()
    .pipe(QuestionTimePreferenceSchema.unwrap().shape.intervals) })
]), asked_speaker: z.enum(["user", "assistant", "either"]).optional(),
evidence_statements: z.array(z.string()).optional(),
evidence_conditions: z.array(EvidenceConditionSchema).optional() });

/** Bound question coordinates enter the public proposal contract. Source matching remains
 * a separate consumer decision; malformed formation is not successful absence. Evidence
 * conditions travel unchanged as navigation demands beside any time or template proposal. */
export function queryProposalFromCoordinates(query: string, clock: string,
  frozen: unknown): QueryInterpretationProposal | undefined {
  const envelope = CoordinateEnvelope.parse(frozen);
  if (envelope.status !== "formed") return undefined;
  const coordinates = Coordinates.parse(envelope.coordinates);
  const sourceTemplate = (coordinates.asked_speaker === "user" || coordinates.asked_speaker === "assistant")
    && coordinates.evidence_statements !== undefined ? {
      interpretation_clock: clock, asked_speaker: coordinates.asked_speaker,
      evidence_statements: coordinates.evidence_statements
    } : undefined;
  const conditions = coordinates.evidence_conditions?.length ? coordinates.evidence_conditions : undefined;
  if (coordinates.time.kind !== "window" && sourceTemplate === undefined && conditions === undefined) return undefined;
  return QueryInterpretationProposalSchema.parse({ schema_version: 1,
    original_query_digest: `sha256:${createHash("sha256").update(query, "utf8").digest("hex")}`,
    producer_id: sourceTemplate === undefined ? QUESTION_TIME_PROPOSAL_PRODUCER_ID : SOURCE_TEMPLATE_PROPOSAL_PRODUCER_ID,
    producer_version: "1",
    ...(coordinates.time.kind === "window" ? {
      question_time: { interpretation_clock: clock, intervals: coordinates.time.alternatives }
    } : {}),
    ...(sourceTemplate === undefined ? {} : { source_template: sourceTemplate }),
    ...(conditions === undefined ? {} : { evidence_conditions: conditions })
  });
}
