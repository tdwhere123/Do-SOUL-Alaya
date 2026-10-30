import { z } from "zod";
import { SourceInterpretationResponseSchema, SourceStatementRequestSchema, SourceStatementSchema,
  SourceStatementResponseMessageSchema, SOURCE_STATEMENT_LIMITS } from "@do-soul/alaya-protocol";
import { parseOfficialApiExtractionRequest } from "./extraction-request.js";
import { parseOfficialApiSourcePacketRequest } from "./source-packet-request.js";
import { officialApiSourcePacketResponseSchema } from "./source-packet-schema.js";
import { parseSourceSemanticRequest, sourceSemanticResponseJsonSchema } from "./source-semantic-request.js";

const semanticSchemaPreimages = new Map<string, string>();
const statementResponseSchema = z.toJSONSchema(z.object({ messages: z.array(
  SourceStatementResponseMessageSchema.extend({ statements: z.array(SourceStatementSchema).max(SOURCE_STATEMENT_LIMITS.perMessage) })
).max(SOURCE_STATEMENT_LIMITS.requestMessages) }).strict(), { io: "input" });
const statementResponsePreimage = JSON.stringify(statementResponseSchema);
function isStatementRequest(userPrompt: string): boolean {
  try { return SourceStatementRequestSchema.safeParse(JSON.parse(userPrompt)).success; } catch { return false; }
}

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
  return responseSchemaPreimage(userPrompt);
}

function responseSchemaPreimage(userPrompt: string): string {
  if (isStatementRequest(userPrompt)) return statementResponsePreimage;
  const packetSchema = sourcePacketSchema(userPrompt);
  if (packetSchema !== undefined) return JSON.stringify(packetSchema);
  const semanticRequest = sourceSemanticRequest(userPrompt);
  if (semanticRequest !== undefined) {
    const contract = JSON.stringify([semanticRequest.source_request.proposal_contract ?? "canonical-envelope",
      semanticRequest.source_request.generation_schema_contract ?? null]);
    let preimage = semanticSchemaPreimages.get(contract);
    if (preimage === undefined) {
      preimage = JSON.stringify(sourceSemanticResponseJsonSchema(semanticRequest));
      semanticSchemaPreimages.set(contract, preimage);
    }
    return preimage;
  }
  return isOfficialApiExtractionRequestPrompt(userPrompt)
    ? OFFICIAL_API_EXTRACTION_RESPONSE_SCHEMA_PREIMAGE
    : "null";
}

/** Query/protocol probes have different envelopes and must not inherit this schema. */
export function officialApiExtractionResponseSchema(userPrompt: string): object | undefined {
  if (isStatementRequest(userPrompt)) return structuredClone(statementResponseSchema);
  const packetSchema = sourcePacketSchema(userPrompt);
  if (packetSchema !== undefined) return packetSchema;
  const semanticRequest = sourceSemanticRequest(userPrompt);
  if (semanticRequest !== undefined) return structuredClone(sourceSemanticResponseJsonSchema(semanticRequest));
  if (!isOfficialApiExtractionRequestPrompt(userPrompt)) return undefined;
  return structuredClone(responseSchema);
}

function sourcePacketSchema(userPrompt: string): object | undefined {
  try { return officialApiSourcePacketResponseSchema(parseOfficialApiSourcePacketRequest(JSON.parse(userPrompt))); }
  catch { return undefined; }
}

function sourceSemanticRequest(userPrompt: string): ReturnType<typeof parseSourceSemanticRequest> | undefined {
  try {
    return parseSourceSemanticRequest(JSON.parse(userPrompt));
  } catch {
    return undefined;
  }
}
