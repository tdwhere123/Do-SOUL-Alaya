import {
  canonicalJson, sourceSemanticInterpretationIdentity,
  type RequestBudget, type SourceSemanticCorrespondence, type SourceSemanticHandleDescriptor,
  type SourceSemanticQuery, type SourceSemanticWorkerResult, type SourceSemanticWorkerWork
} from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "../../shared/field-hash.js";
import { sourceLiteralOccurs } from "../../memory/evidence-create/source-utf8-hydrate.js";
import { admitSourceSemanticCorrespondence } from "../conditional-field/query/source-semantic-correspondence-admission.js";

/** Private Node seam for the daemon feedback adapter and its cache-only bench collaborator.
 * It is not a worker operation, producer authority, or cross-H binding transfer. */
export type SourceFeedbackCorrespondenceRequest = Readonly<{
  kind: "prepare_correspondence";
  policy_id: string;
  origin_action_id: string; origin_exposure_id: string;
  access_hint: string;
  descriptor: SourceSemanticHandleDescriptor;
  query_handle: string;
  original_query: string; query_semantics: SourceSemanticQuery;
  budget: RequestBudget;
}>;
export type SourceFeedbackCorrespondenceAction = Readonly<{
  action_id: string; demand_id: string; parent_entitlement_id: string;
  request: SourceFeedbackCorrespondenceRequest;
}>;
export type SourceFeedbackCorrespondenceResult = Readonly<{
  /** Exact action/exposure/parent binding, including H identity, version and digest. */
  action: SourceFeedbackCorrespondenceAction;
  work?: SourceSemanticWorkerWork;
  new_dispatches: 0;
  historical_production: Readonly<{ status: "unknown" }> | Readonly<{
    status: "reported"; usage: Readonly<{ inputTokens: number; outputTokens: number; totalTokens: number }>;
  }>;
  cache_key?: string;
}> & (Readonly<{ status: "ready"; semantic_correspondence: SourceSemanticCorrespondence }>
  | Readonly<{ status: "unavailable"; reason: string }>
  | Readonly<{ status: "unknown"; reason: string }>);
export type SourceFeedbackCorrespondenceHost = Readonly<{
  policy_id: string;
  prepare(action: SourceFeedbackCorrespondenceAction): Promise<SourceFeedbackCorrespondenceResult>;
}>;

export function feedbackDescriptorIsBound(descriptor: SourceSemanticHandleDescriptor): boolean {
  const h = descriptor.interpretation;
  return h !== undefined && sourceSemanticInterpretationIdentity(h, fieldContractSha256) === descriptor.interpretation_id
    && h.source.source_id === descriptor.source_id && h.source.source_version === descriptor.source_version
    && h.source.content_digest === descriptor.content_digest && h.producer_id === descriptor.producer_id
    && h.producer_version === descriptor.producer_version && h.contract_version === descriptor.contract_version;
}

/** Literal occurrence under the existing NFC owner is navigation only, not identity or correspondence.
 * Preserve the worker's order among bound matches; an unread/off-page H is not selectable. */
export function selectFeedbackHintDescriptor(candidates: readonly SourceSemanticHandleDescriptor[], seedId: string,
  hint: string | undefined) {
  if (hint === undefined) return { status: "unavailable" as const, reason: "missing_access_hint" };
  let reason = "missing_descriptor";
  for (const descriptor of candidates) {
    if (descriptor.interpretation_id === seedId) continue;
    if (descriptor.interpretation === undefined) { reason = "descriptor_id_only"; continue; }
    if (!feedbackDescriptorIsBound(descriptor)) { reason = "descriptor_mismatch"; continue; }
    if (descriptor.interpretation.mentions.some(mention => sourceLiteralOccurs(mention.text, hint))) {
      return { status: "matched" as const, descriptor };
    }
    if (reason === "missing_descriptor") reason = "hint_descriptor_not_exposed";
  }
  return { status: "unavailable" as const, reason };
}

export function admitFeedbackCorrespondence(action: SourceFeedbackCorrespondenceAction, result: SourceFeedbackCorrespondenceResult) {
  if (result.status !== "ready" || canonicalJson(result.action) !== canonicalJson(action)
    || !feedbackDescriptorIsBound(action.request.descriptor)) return undefined;
  const admission = admitSourceSemanticCorrespondence({ source_interpretation: action.request.descriptor.interpretation!,
    query_semantics: action.request.query_semantics, original_query: action.request.original_query,
    semantic_correspondence: result.semantic_correspondence });
  return admission.kind === "admitted" ? admission : undefined;
}

/** Follow-forward reason has its own native snapshot. Never apply seed navigation validation to it. */
export function feedbackQualificationMatches(action: SourceFeedbackCorrespondenceAction,
  correspondence: SourceSemanticCorrespondence, delivery: Extract<SourceSemanticWorkerResult, { kind: "reason" }>, workspaceId: string): boolean {
  const { descriptor, original_query, query_semantics } = action.request;
  if (!feedbackDescriptorIsBound(descriptor) || delivery.interpretation === undefined || delivery.query === undefined
    || delivery.semantic_correspondence === undefined || delivery.context === undefined || delivery.result === undefined
    || delivery.result.source_target?.workspace_id !== workspaceId
    || delivery.result.source_target.source_version !== descriptor.source_version
    || delivery.result.source_target.content_digest !== descriptor.content_digest
    || canonicalJson(delivery.interpretation) !== canonicalJson(descriptor.interpretation)
    || canonicalJson(delivery.query) !== canonicalJson(query_semantics)
    || canonicalJson(delivery.semantic_correspondence) !== canonicalJson(correspondence)) return false;
  const admission = admitSourceSemanticCorrespondence({ source_interpretation: delivery.interpretation,
    query_semantics, original_query, semantic_correspondence: correspondence });
  return admission.kind === "admitted" && canonicalJson(delivery.context) === canonicalJson(admission.context)
    && delivery.result.source_interpretation_id === descriptor.interpretation_id
    && delivery.result.query_semantics_id === admission.query_id
    && delivery.result.semantic_correspondence_id === admission.semantic_correspondence_id
    && delivery.result.conditional_computation_id === admission.context_id;
}
