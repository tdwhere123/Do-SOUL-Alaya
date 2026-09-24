import {
  SourceSemanticQuerySchema, SourceSemanticCorrespondenceSchema, sourceSemanticQueryIdentity,
  SOURCE_SEMANTIC_CORRESPONDENCE_CONTRACT,
  SOURCE_SEMANTIC_QUERY_CONTRACT, SOURCE_SEMANTIC_CORRESPONDENCE_SELECTION_CONTRACT,
  UNKNOWN_UTTERANCE_ATTRIBUTION,
  encodeSourceSemanticQueryCarrier, type SourceSemanticQueryMeaningBody,
  type SourceSemanticQuery
} from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import { buildSourceSemanticCorrespondenceRequest, proposeCorrespondenceSemantics,
  SOURCE_SEMANTIC_QUERY_MEANING_RESPONSE_CONTRACT,
  type SourceSemanticQueryProposalInput, type SourceSemanticCorrespondenceProposalInput } from "@do-soul/alaya-soul";

/** Encode authored nested meaning through the current producer wire for native boundary tests. */
export function queryWire(rawJson: string): string {
  const response = JSON.parse(rawJson);
  return JSON.stringify({ ...response, contract: SOURCE_SEMANTIC_QUERY_MEANING_RESPONSE_CONTRACT,
    query: encodeSourceSemanticQueryCarrier(response.query as SourceSemanticQueryMeaningBody) });
}

/** Authored native queries isolate worker semantics from producer-language tests. */
export function authoredQuerySemantics(input: SourceSemanticQueryProposalInput, body: unknown) {
  const query = SourceSemanticQuerySchema.parse({ contract: SOURCE_SEMANTIC_QUERY_CONTRACT,
    original_query_digest: `sha256:${fieldContractSha256(input.original_query)}`,
    producer_id: input.producer_id, producer_version: input.producer_version,
    approved_fixed_context: input.approved_fixed_context ?? null,
    attribution_context: input.attribution_context ?? UNKNOWN_UTTERANCE_ATTRIBUTION,
    contract_version: SOURCE_SEMANTIC_QUERY_CONTRACT, ...(body as object) });
  return { query, outcome: { status: "interpreted" as const } };
}

/** Specify intended endpoint pairs; encode the current advertised producer catalog. */
export function correspondenceSelectionJson(input: SourceSemanticCorrespondenceProposalInput, body: unknown,
  outcome: object = { status: "interpreted", gaps: [] }) {
  const request = buildSourceSemanticCorrespondenceRequest(input);
  const { source_interpretation_handle = "source1", ...nativeBody } = body as Record<string, unknown>;
  const selected = String(source_interpretation_handle);
  const desired = SourceSemanticCorrespondenceSchema.parse({ contract: SOURCE_SEMANTIC_CORRESPONDENCE_CONTRACT,
    source_interpretation_id: request.source_interpretation_descriptors[0]!.source_interpretation_id,
    query_semantics_id: sourceSemanticQueryIdentity(request.admitted_query_semantics, fieldContractSha256),
    producer_id: input.producer_id, producer_version: input.producer_version,
    contract_version: SOURCE_SEMANTIC_CORRESPONDENCE_CONTRACT, ...nativeBody });
  const matches = (endpoint: object, candidate: object) => Object.entries(endpoint)
    .every(([key, value]) => (candidate as Record<string, unknown>)[key] === value);
  const selections = desired.correspondences.map((pair) => {
    const query = request.catalog.query_endpoints.find((row) => matches(pair.query_endpoint, row));
    const source = request.catalog.source_endpoints.find((row) => row.source_interpretation_handle === selected
      && matches(pair.source_endpoint, row));
    if (query === undefined || source === undefined) throw new Error("authored endpoint is outside current catalog");
    return { query: query.handle, source: source.handle, query_excerpt: pair.query_support.excerpt,
      source_semantic_support: pair.source_semantic_support,
      ...(pair.applicable_context === undefined ? {} : { applicable_context: pair.applicable_context }) };
  });
  return JSON.stringify({ contract: "source-semantic-correspondence-response-v3", outcome,
    semantic_correspondence: { contract: SOURCE_SEMANTIC_CORRESPONDENCE_SELECTION_CONTRACT,
      source_interpretation_handle: selected, selections,
      ...(desired.domains === undefined ? {} : { domains: desired.domains }),
      ...(desired.membership_assumptions === undefined ? {} : { membership_assumptions: desired.membership_assumptions }) } });
}

export function receiveAuthoredCorrespondence(input: SourceSemanticCorrespondenceProposalInput, body: unknown,
  outcome?: object) {
  return proposeCorrespondenceSemantics(input, { rawJson: correspondenceSelectionJson(input, body, outcome) });
}

export type AuthoredQuerySemantics = SourceSemanticQuery;
