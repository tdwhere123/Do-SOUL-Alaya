import {
  canonicalJson, type RequestBudget, type SourceSemanticAccessPolicy, type SourceSemanticAccessSignal,
  type SourceSemanticInterpretation, type SourceSemanticQuery, type SourceSemanticResourceLedger,
  type SourceSemanticPreviewExtents, SourceSemanticAccessProfileSchema, type SourceSemanticAccessProfile
} from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "../../shared/field-hash.js";
import { CoreError } from "../../shared/errors.js";
import { captureProfiledSourceIndexExecutionProfile } from "../../source-index/source-index-profiled-acquisition.js";
import { createSourceRecallAccessPolicy } from "./source-recall-access.js";

const SOURCE_SEMANTIC_ACCESS_RESOURCE_CONTRACT = "empty-interpretation-reserve-v1";

export function sourceSemanticAccessInputIdentity(input: Readonly<{
  original_query: string; query_semantics?: SourceSemanticQuery; source_id?: string; access_hint?: string;
  budget: RequestBudget; source_preview_extents?: SourceSemanticPreviewExtents;
}> & ({ policy: SourceSemanticAccessPolicy; contract?: "source-semantic-access-v2"; candidate_profile?: never }
  | { candidate_profile: SourceSemanticAccessProfile; policy?: never; contract?: never })): string {
  // Capture new profile material before validation without adding copies to the legacy path.
  if (Object.hasOwn(input, "candidate_profile")) input = structuredClone(input);
  const candidate = input.candidate_profile === undefined ? undefined : SourceSemanticAccessProfileSchema.parse(input.candidate_profile);
  if (candidate !== undefined && (input.policy !== undefined || input.contract !== undefined)) {
    throw new CoreError("VALIDATION", "candidate profile cannot accompany a legacy access policy or contract");
  }
  return `sha256:${fieldContractSha256(canonicalJson({ original_query: input.original_query,
    query_semantics: input.query_semantics, source_id: input.source_id, budget: input.budget,
    ...(candidate === undefined ? { policy: input.policy } : { candidate_profile: candidate }),
    ...(input.access_hint === undefined ? {} : { access_hint: input.access_hint }),
    ...(input.source_preview_extents === undefined ? {} : { source_preview_extents: input.source_preview_extents }),
    resource_contract: candidate !== undefined || input.contract === "source-semantic-access-v2" ? "original-first-navigation-v3" :
      SOURCE_SEMANTIC_ACCESS_RESOURCE_CONTRACT }))}`;
}

/** One profile/family normalization rule for preparation, worker reuse and retained leases. */
export function resolveSourceSemanticComparisonProfile(input: Readonly<{
  comparison?: Readonly<{ profile?: unknown }>; bound?: Readonly<{ profile?: SourceSemanticAccessProfile }>;
  public_policy?: SourceSemanticAccessPolicy;
}>): SourceSemanticAccessProfile | undefined {
  if (input.comparison === undefined) {
    if (input.bound?.profile !== undefined) throw new CoreError("VALIDATION", "candidate handle requires private comparison ingress");
    return undefined;
  }
  if (input.public_policy !== undefined) throw new CoreError("VALIDATION", "private profile cannot accompany public access policy");
  if (input.bound !== undefined && input.bound.profile === undefined) throw new CoreError("VALIDATION", "public handle cannot enter private comparison");
  const supplied = Object.hasOwn(input.comparison, "profile")
    ? captureProfiledSourceIndexExecutionProfile(input.comparison.profile) : undefined;
  const retained = input.bound?.profile;
  if (supplied === undefined && retained === undefined) throw new CoreError("VALIDATION", "initial comparison requires an explicit profile");
  if (supplied !== undefined && retained !== undefined && canonicalJson(supplied) !== canonicalJson(retained)) {
    throw new CoreError("VALIDATION", "comparison profile conflicts with the frozen handle");
  }
  return retained ?? supplied;
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
