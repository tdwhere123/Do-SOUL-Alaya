import { createHash } from "node:crypto";
import { z } from "zod";
import { QUESTION_TIME_PROPOSAL_PRODUCER_ID, QuestionTimePreferenceSchema, QueryInterpretationProposalSchema,
  type QueryInterpretationProposal } from "@do-soul/alaya-protocol";

const CoordinateEnvelope = z.looseObject({ status: z.string(), coordinates: z.unknown().optional() });
const Coordinates = z.looseObject({ time: z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("absent"), alternatives: z.array(z.unknown()).length(0).optional() }),
  z.object({ kind: z.literal("window"), alternatives: z.array(z.object({ start: z.string(), end: z.string() })).readonly()
    .pipe(QuestionTimePreferenceSchema.unwrap().shape.intervals) })
]) });

/** Replay only the frozen question-and-clock formation. Speaker/relation coordinates
 * never enter production. A malformed formation is an error, not successful absence. */
export function questionTimeProposalFromCoordinates(query: string, clock: string,
  frozen: unknown): QueryInterpretationProposal | undefined {
  const envelope = CoordinateEnvelope.parse(frozen);
  if (envelope.status !== "formed") return undefined;
  const coordinates = Coordinates.parse(envelope.coordinates);
  if (coordinates.time.kind !== "window") return undefined;
  return QueryInterpretationProposalSchema.parse({ schema_version: 1,
    original_query_digest: `sha256:${createHash("sha256").update(query, "utf8").digest("hex")}`,
    producer_id: QUESTION_TIME_PROPOSAL_PRODUCER_ID, producer_version: "1",
    question_time: { interpretation_clock: clock, intervals: coordinates.time.alternatives }
  });
}
