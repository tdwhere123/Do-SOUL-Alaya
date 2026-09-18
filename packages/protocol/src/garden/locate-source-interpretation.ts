import { locateSourceTextSelection } from "../evidence/source-selection.js";
import { normalizeMemoryObjectKeySurface } from "../memory/memory-object-key.js";
import type { FieldContractSha256 } from "../recall/field-contract/canonical-identity.js";
import {
  SOURCE_INTERPRETATION_CONTRACT,
  SourceInterpretationResponseEnvelopeSchema,
  SourceInterpretationRelationSchema,
  BoundSourceInterpretationCandidateSchema,
  SourceLocatedInterpretationSchema,
  type SourceInterpretationResponse,
  type SourceLocatedInterpretation
} from "./source-interpretation.js";

type Candidate = SourceLocatedInterpretation["candidates"][number];
type Phrase = Candidate["predicate"];
type Relation = SourceInterpretationResponse["interpretations"][number]["relations"][number];
type Selection = Relation["predicate"];
type Diagnostic = SourceLocatedInterpretation["diagnostics"][number];
type Match = { readonly phrase: Phrase } | { readonly reason: Diagnostic["reason"] };

export interface LocateSourceInterpretationInput {
  readonly source: string;
  readonly artifactKey: string;
  /** Supplied by the trusted catalog owner, never by the model response. */
  readonly assertion: Omit<SourceLocatedInterpretation["assertion_binding"], "context_id">;
  readonly response: { readonly kind: "received"; readonly value: unknown } |
    { readonly kind: "unavailable"; readonly reason: "transport_unknown" | "missing_response" };
  readonly sha256: FieldContractSha256;
}

/** Locates proposals; neither matched phrases nor role labels certify meaning. */
export function locateSourceInterpretation(input: LocateSourceInterpretationInput): SourceLocatedInterpretation {
  const sourceDigest = input.sha256(input.source);
  const contextId = input.sha256(JSON.stringify([
    SOURCE_INTERPRETATION_CONTRACT, input.artifactKey, sourceDigest,
    input.assertion.assertion_id, input.assertion.source_span, input.assertion.text
  ]));
  const base = SourceLocatedInterpretationSchema.parse({
    contract: SOURCE_INTERPRETATION_CONTRACT, artifact_key: input.artifactKey,
    source_corpus_digest: sourceDigest,
    assertion_binding: { ...input.assertion, context_id: contextId },
    outcome: "empty", candidates: [], diagnostics: []
  });
  const [start, end] = base.assertion_binding.source_span;
  if (input.source.slice(start, end) !== base.assertion_binding.text || end > input.source.length) {
    throw new Error("Trusted assertion binding does not match the source corpus");
  }
  if (input.response.kind === "unavailable") return failed(base, input.response.reason);
  const parsed = SourceInterpretationResponseEnvelopeSchema.safeParse(input.response.value);
  if (!parsed.success) return failed(base, "malformed_response");
  const selected = parsed.data.interpretations.filter((entry) =>
    entry.assertion_id === base.assertion_binding.assertion_id);
  // A received, valid response nominates zero or more assertions. Omitting an
  // assertion is no candidate, not evidence of an unreceived transport/shard.
  if (selected.length === 0) return base;
  if (selected.length !== 1) return failed(base, "invalid_candidate");
  const candidates: Candidate[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const [index, relation] of selected[0]!.relations.entries()) {
    const parsedRelation = SourceInterpretationRelationSchema.safeParse(relation);
    if (!parsedRelation.success) {
      diagnostics.push({ candidate_index: index, reason: "invalid_candidate" });
      continue;
    }
    const result = locateRelation(base, parsedRelation.data, index, input.sha256);
    if ("reason" in result) diagnostics.push({ candidate_index: index, reason: result.reason });
    else {
      const candidate = BoundSourceInterpretationCandidateSchema.safeParse(result);
      if (candidate.success) candidates.push(candidate.data);
      else diagnostics.push({ candidate_index: index, reason: "invalid_candidate" });
    }
  }
  return SourceLocatedInterpretationSchema.parse({ ...base, candidates, diagnostics,
    outcome: candidates.length > 0 ? "candidates" : diagnostics.length > 0 ? "failed" : "empty" });
}

function failed(base: SourceLocatedInterpretation, reason: Diagnostic["reason"]): SourceLocatedInterpretation {
  return SourceLocatedInterpretationSchema.parse({ ...base, outcome: "failed",
    diagnostics: [{ candidate_index: null, reason }] });
}

function locateRelation(
  base: SourceLocatedInterpretation, relation: Relation, index: number, sha256: FieldContractSha256
): Candidate | { readonly reason: Diagnostic["reason"] } {
  const predicate = locatePhrase(base, relation.predicate);
  if ("reason" in predicate) return predicate;
  const arguments_: Candidate["arguments"][number][] = [];
  const qualifiers: Candidate["qualifiers"][number][] = [];
  for (const [items, output] of [[relation.arguments, arguments_], [relation.qualifiers, qualifiers]] as const) {
    for (const item of items) {
      const located = locatePhrase(base, item.phrase);
      if ("reason" in located) return located;
      output.push({ role: item.role, phrase: located.phrase });
    }
  }
  return {
    candidate_id: sha256(JSON.stringify([SOURCE_INTERPRETATION_CONTRACT,
      base.artifact_key, base.assertion_binding.context_id, index])),
    context_id: base.assertion_binding.context_id,
    predicate: predicate.phrase, arguments: arguments_, qualifiers,
    // The complete assertion remains the context. Exact matching alone cannot
    // establish governing negation, modality, attachment or semantic scope.
    scope_status: "unsupported"
  };
}

function locatePhrase(base: SourceLocatedInterpretation, selection: Selection): Match {
  const source = base.assertion_binding.text;
  const located = locateSourceTextSelection(source, selection);
  if ("reason" in located) return located;
  const { span } = located;
  const offset = base.assertion_binding.source_span[0];
  return { phrase: { text: selection.text, source_span: [offset + span[0], offset + span[1]],
    lookup_key: normalizeMemoryObjectKeySurface(selection.text) } };
}
