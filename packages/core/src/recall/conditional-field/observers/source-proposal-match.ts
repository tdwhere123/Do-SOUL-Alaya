import {
  BoundSourceInterpretationSchema,
  normalizeMemoryObjectKeySurface,
  type BoundSourceInterpretation
} from "@do-soul/alaya-protocol";
import type { AdoptedSourceProposal, QuerySourceRolePhrase } from "../query/query-source-proposal.js";

export type ProposalMatchReason = Readonly<{
  readonly kind: "proposal";
  readonly predicate_key: string;
  readonly arguments: readonly QuerySourceRolePhrase[];
  readonly qualifiers: readonly QuerySourceRolePhrase[];
  readonly candidate_id: string;
  readonly context_id: string;
}>;

export function parseBoundInterpretationGist(gist: string): BoundSourceInterpretation | null {
  try {
    const parsed = BoundSourceInterpretationSchema.safeParse(JSON.parse(gist));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Conjunction inside one candidate and one source context. No alias or polarity inference. */
export function matchBoundInterpretation(
  bound: BoundSourceInterpretation,
  sketch: AdoptedSourceProposal
): ProposalMatchReason | undefined {
  for (const candidate of bound.candidates) {
    if (candidate.context_id !== bound.assertion_binding.context_id) continue;
    if (!sameKey(candidate.predicate.lookup_key, sketch.predicate_key)) continue;
    if (!rolesMatch(candidate.arguments, sketch.arguments)) continue;
    if (!rolesMatch(candidate.qualifiers, sketch.qualifiers)) continue;
    return {
      kind: "proposal",
      predicate_key: sketch.predicate_key,
      arguments: sketch.arguments,
      qualifiers: sketch.qualifiers,
      candidate_id: candidate.candidate_id,
      context_id: candidate.context_id
    };
  }
  return undefined;
}

export function sourceTextContainsPhrases(
  content: string | undefined,
  phrases: readonly string[]
): boolean {
  if (content === undefined || phrases.length === 0) return false;
  const haystack = normalizeMemoryObjectKeySurface(content);
  return phrases.every((phrase) => haystack.includes(normalizeMemoryObjectKeySurface(phrase)));
}

function rolesMatch(
  actual: readonly { readonly role: string; readonly phrase: { readonly lookup_key: string } }[],
  required: readonly QuerySourceRolePhrase[]
): boolean {
  return required.every((want) => actual.some((item) =>
    sameKey(item.role, want.role) && sameKey(item.phrase.lookup_key, want.phrase)));
}

function sameKey(left: string, right: string): boolean {
  return normalizeMemoryObjectKeySurface(left) === normalizeMemoryObjectKeySurface(right);
}
