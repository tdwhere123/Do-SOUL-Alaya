import { z } from "zod";
import { SourceInterpretationResponseSchema } from "@do-soul/alaya-protocol";
import { parseOfficialApiExtractionRequest } from "./extraction-request.js";

// This constrains generation, not admission: historical raw still uses its
// recorded signals envelope and parser. Live ordinary extraction asks for
// source-interpretation-v1 only.
const responseSchema = z.toJSONSchema(SourceInterpretationResponseSchema, {
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

function isOfficialApiExtractionRequestPrompt(userPrompt: string): boolean {
  try {
    parseOfficialApiExtractionRequest(JSON.parse(userPrompt));
    return true;
  } catch {
    return false;
  }
}

/** Stable cache-key bytes; cloning the live schema object per shard is not required. */
export function officialApiExtractionResponseSchemaPreimage(userPrompt: string): string {
  return isOfficialApiExtractionRequestPrompt(userPrompt)
    ? OFFICIAL_API_EXTRACTION_RESPONSE_SCHEMA_PREIMAGE
    : "null";
}

/** Query/protocol probes have different envelopes and must not inherit this schema. */
export function officialApiExtractionResponseSchema(userPrompt: string): object | undefined {
  if (!isOfficialApiExtractionRequestPrompt(userPrompt)) return undefined;
  return structuredClone(responseSchema);
}
