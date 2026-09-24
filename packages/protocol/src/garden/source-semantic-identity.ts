import { canonicalJson } from "../recall/selection/capture/canonical-json.js";
import type { FieldContractSha256 } from "../recall/field-contract/canonical-identity.js";
import {
  SourceSemanticInterpretationSchema, RetainedSourceSemanticInterpretationSchema,
  SOURCE_SEMANTIC_PUBLISHED_CONTRACT,
  type SourceSemanticInterpretation, type RetainedSourceSemanticInterpretation
} from "./source-semantic-interpretation.js";
import {
  SourceSemanticQuerySchema, SOURCE_SEMANTIC_QUERY_CONTRACT, type SourceSemanticQuery
} from "../recall/conditional-field/semantic-query.js";
import {
  SourceSemanticCorrespondenceSchema, SOURCE_SEMANTIC_CORRESPONDENCE_CONTRACT, type SourceSemanticCorrespondence
} from "../recall/conditional-field/semantic-correspondence.js";
import {
  SourceSemanticEvaluationContextSchema, SOURCE_SEMANTIC_CONTEXT_CONTRACT,
  type SourceSemanticEvaluationContext
} from "../recall/conditional-field/interpretation-context.js";

export function sourceSemanticInterpretationPreimage(interpretation: SourceSemanticInterpretation) {
  const value = SourceSemanticInterpretationSchema.parse(interpretation);
  return interpretationPreimage(value, SOURCE_SEMANTIC_PUBLISHED_CONTRACT);
}

export function retainedSourceSemanticInterpretationPreimage(interpretation: RetainedSourceSemanticInterpretation) {
  return interpretationPreimage(RetainedSourceSemanticInterpretationSchema.parse(interpretation),
    "published-source-interpretation-v4");
}

function interpretationPreimage(value: SourceSemanticInterpretation | RetainedSourceSemanticInterpretation,
  contract: string) {
  return {
    contract,
    k_version: value.k_version,
    normalizer_version: value.normalizer_version,
    source: value.source,
    producer_id: value.producer_id,
    producer_version: value.producer_version,
    contract_version: value.contract_version,
    body: {
      contract: value.contract,
      mentions: value.mentions.map(({ utf8_span: _span, span_space: _space, ...mention }) => mention),
      referents: value.referents,
      frames: value.frames,
      operators: value.operators,
      domains: value.domains ?? [],
      measurements: value.measurements ?? [],
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
    approved_fixed_context: value.approved_fixed_context,
    attribution_context: value.attribution_context,
    producer_id: value.producer_id,
    producer_version: value.producer_version,
    contract_version: value.contract_version,
    body: {
      contract: value.contract,
      variables: value.variables,
      alternatives: value.alternatives,
      return_variables: value.return_variables,
      gaps: value.gaps,
      domains: value.domains ?? [], evaluation: value.evaluation ?? null,
      requested_operation: value.requested_operation ?? null
    }
  };
}

export function sourceSemanticCorrespondencePreimage(semantic_correspondence: SourceSemanticCorrespondence) {
  const value = SourceSemanticCorrespondenceSchema.parse(semantic_correspondence);
  return {
    contract: SOURCE_SEMANTIC_CORRESPONDENCE_CONTRACT,
    source_interpretation_id: value.source_interpretation_id,
    query_semantics_id: value.query_semantics_id,
    producer_id: value.producer_id,
    producer_version: value.producer_version,
    contract_version: value.contract_version,
    body: { contract: value.contract, correspondences: value.correspondences,
      domains: value.domains ?? [], membership_assumptions: value.membership_assumptions ?? [] }
  };
}

export function sourceSemanticContextPreimage(context: SourceSemanticEvaluationContext) {
  const value = SourceSemanticEvaluationContextSchema.parse(context);
  return {
    contract: SOURCE_SEMANTIC_CONTEXT_CONTRACT,
    source_interpretation_id: value.source_interpretation_id,
    query_semantics_id: value.query_semantics_id,
    semantic_correspondence_id: value.semantic_correspondence_id,
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

export function retainedSourceSemanticInterpretationIdentity(
  interpretation: RetainedSourceSemanticInterpretation, sha256: FieldContractSha256
): string {
  return digest(retainedSourceSemanticInterpretationPreimage(interpretation), sha256);
}

export function sourceSemanticQueryIdentity(query: SourceSemanticQuery, sha256: FieldContractSha256): string {
  return digest(sourceSemanticQueryPreimage(query), sha256);
}

export function sourceSemanticCorrespondenceIdentity(
  semantic_correspondence: SourceSemanticCorrespondence, sha256: FieldContractSha256
): string {
  return digest(sourceSemanticCorrespondencePreimage(semantic_correspondence), sha256);
}

export function sourceSemanticContextIdentity(
  context: SourceSemanticEvaluationContext, sha256: FieldContractSha256
): string {
  return digest(sourceSemanticContextPreimage(context), sha256);
}
