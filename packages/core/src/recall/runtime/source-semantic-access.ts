import {
  canonicalJson, type RequestBudget, type SourceSemanticAccessPolicy, type SourceSemanticAccessSignal,
  type SourceSemanticInterpretation, type SourceSemanticQuery, type SourceSemanticResourceLedger,
  type SourceSemanticPreviewExtents
} from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "../../shared/field-hash.js";
import { CoreError } from "../../shared/errors.js";
import { createSourceRecallAccessPolicy } from "./source-recall-access.js";

const SOURCE_SEMANTIC_ACCESS_RESOURCE_CONTRACT = "empty-interpretation-reserve-v1";

export function sourceSemanticAccessInputIdentity(input: Readonly<{
  original_query: string; query_semantics?: SourceSemanticQuery; source_id?: string; access_hint?: string;
  budget: RequestBudget; policy: SourceSemanticAccessPolicy; source_preview_extents?: SourceSemanticPreviewExtents;
  contract?: "source-semantic-access-v2";
}>): string {
  return `sha256:${fieldContractSha256(canonicalJson({ original_query: input.original_query,
    query_semantics: input.query_semantics, source_id: input.source_id, budget: input.budget, policy: input.policy,
    ...(input.access_hint === undefined ? {} : { access_hint: input.access_hint }),
    ...(input.source_preview_extents === undefined ? {} : { source_preview_extents: input.source_preview_extents }),
    resource_contract: input.contract === "source-semantic-access-v2" ? "original-first-navigation-v3" :
      SOURCE_SEMANTIC_ACCESS_RESOURCE_CONTRACT }))}`;
}

export function authorizeSemanticScope(scope: string | null | undefined, authorized: readonly string[] | null): void {
  if (scope == null) throw new CoreError("VALIDATION", "source has no governed scope", { details: { admission: "filtered" } });
  if (authorized !== null && !authorized.includes(scope)) {
    throw new CoreError("VALIDATION", "source is outside authorized scopes", { details: { admission: "filtered" } });
  }
}

/** Semantic admission supplies reading facts to the one native access policy. */
export function createSourceSemanticAccessPolicy(original: string, query: SourceSemanticQuery | undefined,
  policy: SourceSemanticAccessPolicy, meter: SourceSemanticResourceLedger, accessHint?: string) {
  const native = createSourceRecallAccessPolicy(original, compile => (query?.alternatives ?? []).flatMap((alternative, index) => alternative.frames
    .filter((frame) => frame.operator === undefined)
    .map((frame) => ({ alternative: index, frame: frame.id, probes: compile(frame.predicate_reading) }))), policy, meter, accessHint);
  return { ...native, interpretation: (source: SourceSemanticAccessSignal, interpretation: SourceSemanticInterpretation,
    ledger: SourceSemanticResourceLedger): SourceSemanticAccessSignal => native.interpretation(source, interpretation.frames, ledger) };
}
