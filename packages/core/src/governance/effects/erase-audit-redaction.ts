import {
  CanonicalizationAliasResolvedPayloadSchema,
  CanonicalizationAppliedPayloadSchema,
  SoulSlotCreatedPayloadSchema,
  SourceEraseRedactionSchema
} from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";

/** Produce an explicitly redacted view while retaining the original event envelope. */
export function redactSourceDerivedClaimEvent(
  eventType: string,
  payload: unknown,
  barrierId: string
): unknown {
  const redaction = SourceEraseRedactionSchema.parse({ kind: "source_erase", barrier_id: barrierId });
  if (eventType === "canonicalization.applied") {
    const parsed = CanonicalizationAppliedPayloadSchema.parse(payload);
    return parsed.input === null ? parsed : CanonicalizationAppliedPayloadSchema.parse({
      ...parsed, input: null, canonical: null, domain: null, redaction
    });
  }
  if (eventType === "canonicalization.alias_resolved") {
    const parsed = CanonicalizationAliasResolvedPayloadSchema.parse(payload);
    return parsed.alias === null ? parsed : CanonicalizationAliasResolvedPayloadSchema.parse({
      ...parsed, alias: null, canonical: null, domain: null, redaction
    });
  }
  if (eventType === "soul.slot.created") {
    const parsed = SoulSlotCreatedPayloadSchema.parse(payload);
    return parsed.governance_subject === null ? parsed : SoulSlotCreatedPayloadSchema.parse({
      ...parsed, governance_subject: null, redaction
    });
  }
  throw new CoreError("VALIDATION", `Unsupported source-erasure event type: ${eventType}`);
}
