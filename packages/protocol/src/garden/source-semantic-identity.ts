import { canonicalJson } from "../recall/selection/capture/canonical-json.js";
import type { FieldContractSha256 } from "../recall/field-contract/canonical-identity.js";
import {
  SourceSemanticInterpretationSchema, SOURCE_SEMANTIC_PUBLISHED_CONTRACT,
  type SourceSemanticInterpretation
} from "./source-semantic-interpretation.js";
import {
  SourceSemanticQuerySchema, SOURCE_SEMANTIC_QUERY_CONTRACT, type SourceSemanticQuery
} from "../recall/conditional-field/semantic-query.js";
import {
  SourceSemanticAlignmentSchema, SOURCE_SEMANTIC_ALIGNMENT_CONTRACT, type SourceSemanticAlignment
} from "../recall/conditional-field/semantic-alignment.js";
import {
  SourceSemanticEvaluationContextSchema, SOURCE_SEMANTIC_CONTEXT_CONTRACT,
  type SourceSemanticEvaluationContext
} from "../recall/conditional-field/interpretation-context.js";

export function sourceSemanticInterpretationPreimage(interpretation: SourceSemanticInterpretation) {
  const value = SourceSemanticInterpretationSchema.parse(interpretation);
  return {
    contract: SOURCE_SEMANTIC_PUBLISHED_CONTRACT,
    k_version: value.k_version,
    normalizer_version: value.normalizer_version,
    source: value.source,
    producer_id: value.producer_id,
    producer_version: value.producer_version,
    contract_version: value.contract_version,
    body: {
      contract: value.contract,
      mentions: value.mentions.map(({ utf8_span: _span, ...mention }) => mention),
      referents: value.referents,
      frames: value.frames,
      operators: value.operators,
      gaps: value.gaps,
      entry_roots: value.entry_roots,
      asserted_at_scope: value.asserted_at_scope
    }
  };
}

export function sourceSemanticQueryPreimage(query: SourceSemanticQuery) {
  const value = SourceSemanticQuerySchema.parse(query);
  return {
    contract: SOURCE_SEMANTIC_QUERY_CONTRACT,
    original_query_digest: value.original_query_digest,
    producer_id: value.producer_id,
    producer_version: value.producer_version,
    contract_version: value.contract_version,
    body: {
      contract: value.contract,
      variables: value.variables,
      alternatives: value.alternatives,
      return_variables: value.return_variables,
      gaps: value.gaps
    }
  };
}

export function sourceSemanticAlignmentPreimage(alignment: SourceSemanticAlignment) {
  const value = SourceSemanticAlignmentSchema.parse(alignment);
  return {
    contract: SOURCE_SEMANTIC_ALIGNMENT_CONTRACT,
    h_id: value.h_id,
    q_id: value.q_id,
    producer_id: value.producer_id,
    producer_version: value.producer_version,
    contract_version: value.contract_version,
    body: { contract: value.contract, correspondences: value.correspondences }
  };
}

export function sourceSemanticContextPreimage(context: SourceSemanticEvaluationContext) {
  const value = SourceSemanticEvaluationContextSchema.parse(context);
  return {
    contract: SOURCE_SEMANTIC_CONTEXT_CONTRACT,
    h_id: value.h_id,
    q_id: value.q_id,
    a_id: value.a_id,
    k_version: value.k_version,
    lowering_version: value.lowering_version
  };
}

function digest(preimage: unknown, sha256: FieldContractSha256): string {
  return `sha256:${sha256(canonicalJson(preimage))}`;
}

export function sourceSemanticInterpretationIdentity(
  interpretation: SourceSemanticInterpretation, sha256: FieldContractSha256
): string {
  return digest(sourceSemanticInterpretationPreimage(interpretation), sha256);
}

export function sourceSemanticQueryIdentity(query: SourceSemanticQuery, sha256: FieldContractSha256): string {
  return digest(sourceSemanticQueryPreimage(query), sha256);
}

export function sourceSemanticAlignmentIdentity(
  alignment: SourceSemanticAlignment, sha256: FieldContractSha256
): string {
  return digest(sourceSemanticAlignmentPreimage(alignment), sha256);
}

export function sourceSemanticContextIdentity(
  context: SourceSemanticEvaluationContext, sha256: FieldContractSha256
): string {
  return digest(sourceSemanticContextPreimage(context), sha256);
}
