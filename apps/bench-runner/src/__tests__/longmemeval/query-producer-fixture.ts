import { encodeSourceSemanticQueryCarrier, SourceSemanticQueryMeaningBodySchema } from "@do-soul/alaya-protocol";
import { SOURCE_SEMANTIC_QUERY_MEANING_RESPONSE_CONTRACT } from "@do-soul/alaya-soul";

/** Author nested meaning once and pass it through the current production wire encoder. */
export function interpretedQueryRaw(query: unknown): string {
  return JSON.stringify({ contract: SOURCE_SEMANTIC_QUERY_MEANING_RESPONSE_CONTRACT,
    outcome: { status: "interpreted" },
    query: encodeSourceSemanticQueryCarrier(SourceSemanticQueryMeaningBodySchema.parse(query)) });
}
