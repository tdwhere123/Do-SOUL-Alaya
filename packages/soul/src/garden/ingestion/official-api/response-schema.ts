import { z } from "zod";
import { OpenSemanticFactorGraphProposalSchema } from "@do-soul/alaya-protocol";
import { OfficialApiSourceLocatorSchema } from "../../triage/grounding/source-locator.js";
import { OFFICIAL_API_SIGNAL_LIMIT } from "../official-api-signal-parser.js";
import { OFFICIAL_API_OBJECT_KINDS } from "./object-kind-contract.js";
import { parseOfficialApiExtractionRequest } from "./extraction-request.js";
import { OfficialApiTemporalProjectionDraftSchema } from "../../extraction/temporal/projection-draft.js";

// This constrains generation, not admission: older/raw proposals still pass
// through the shared parser and grounding owners, including graph rejection.
// Additional signal fields preserve the independent optional projections.
const responseSchema = z.toJSONSchema(z.object({
  signals: z.array(z.looseObject({
    object_kind: z.enum(OFFICIAL_API_OBJECT_KINDS),
    confidence: z.number().min(0).max(1),
    matched_text: z.string(),
    source_locator: OfficialApiSourceLocatorSchema,
    semantic_factor_graph: OpenSemanticFactorGraphProposalSchema,
    temporal_projection: OfficialApiTemporalProjectionDraftSchema.optional()
  })).max(OFFICIAL_API_SIGNAL_LIMIT)
}).strict(), {
  io: "input",
  override: ({ jsonSchema }) => {
    // Singleton enums express literals even on providers that ignore `const`.
    if (jsonSchema.const !== undefined) {
      jsonSchema.enum = [jsonSchema.const];
      delete jsonSchema.const;
    }
  }
});

export const OFFICIAL_API_EXTRACTION_RESPONSE_SCHEMA_PREIMAGE = JSON.stringify(responseSchema);

/** Query/protocol probes have different envelopes and must not inherit this schema. */
export function officialApiExtractionResponseSchema(userPrompt: string): object | undefined {
  try { parseOfficialApiExtractionRequest(JSON.parse(userPrompt)); }
  catch { return undefined; }
  return structuredClone(responseSchema);
}
