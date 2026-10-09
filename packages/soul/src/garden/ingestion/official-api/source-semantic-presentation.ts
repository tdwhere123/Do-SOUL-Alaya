import { SOURCE_SEMANTIC_INLINE_GENERATION_CONTRACT, materializeSourceSemanticInlineProposal,
  materializeSourceSemanticTableProposal, type SourceSemanticResourceLedger } from "@do-soul/alaya-protocol";
import { sourceSemanticRequestCatalog, semanticSha256, type SourceSemanticRequest } from "./source-semantic-request.js";

/** The admitted request selects the codec; raw output cannot change that selection. */
export function materializeSourceSemanticPresentation(value: unknown, request: SourceSemanticRequest,
  meter?: SourceSemanticResourceLedger) {
  const materialize = request.source_request.generation_schema_contract === SOURCE_SEMANTIC_INLINE_GENERATION_CONTRACT
    ? materializeSourceSemanticInlineProposal : materializeSourceSemanticTableProposal;
  return materialize(value, { catalog: sourceSemanticRequestCatalog(request), sha256: semanticSha256 }, meter);
}
