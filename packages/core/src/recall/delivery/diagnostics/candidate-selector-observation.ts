import { PathAnchorRefSchema, type PathAnchorRef } from "@do-soul/alaya-protocol";
import type { RecallAnswerSupportObservation } from
  "../../query/recall-answer-support-observation.js";
import type { RecallCandidateAnswerSupport } from
  "../../query/recall-candidate-answer-support.js";
import { isWorkspaceMemoryCandidate } from
  "../../runtime/recall-service-helpers.js";
import {
  foldLexicalMorphology,
  splitLexicalTokens
} from "../../query/recall-query-probes.js";
import { compileRecallQueryDemand } from
  "../../query/recall-query-demand.js";
import { collectRelationDemandTermsFromFactFrameCapture } from
  "../../field/query-attribution/query-fact-frame-attribution-producer.js";
import type {
  PathInflowEdge,
  RecallSelectorDemandAtom,
  RecallSelectorDemandMatch,
  RecallCandidateSelectorObservation,
  RecallSelectorEventStatus,
  RecallSelectorEvidenceAuthority,
  RecallSelectorEvidenceDirectness,
  RecallSelectorEvidenceValidity,
  RecallSelectorPathReceipt,
  RecallSelectorTemporalCompatibility
} from "../../runtime/recall-service-types.js";
import type {
  FineAssessmentCandidate,
  FineAssessmentSelectionContext
} from "../fine-assessment-selection.js";

export function buildCandidateSelectorObservation(
  candidate: FineAssessmentCandidate,
  context: FineAssessmentSelectionContext
): Readonly<RecallCandidateSelectorObservation> {
  const candidateKey = candidate.fusion.candidate_key;
  const support = context.answerSupportByCandidateKey.get(candidateKey);
  const observations = context.answerSupportObservationsByCandidateKey.get(candidateKey) ?? [];
  return Object.freeze({
    schema_version: 2,
    demand: buildDemandObservation(candidate, context),
    evidence: buildEvidenceObservation(candidate, support, observations),
    temporal: buildTemporalObservation(candidate, support, observations),
    coverage: Object.freeze({
      marginal_gain: context.coverageMarginalGainByCandidateKey.get(candidateKey) ?? null
    }),
    path: buildPathObservation(candidate, context)
  });
}

function buildDemandObservation(
  candidate: FineAssessmentCandidate,
  context: FineAssessmentSelectionContext
): RecallCandidateSelectorObservation["demand"] {
  const probes = context.supplementaryData.queryProbes;
  const atoms = compileRecallQueryDemand(probes, {
    soughtFacets: context.supplementaryData.querySoughtFacets,
    sourceExactLexicalTerms:
      context.supplementaryData.queryFactFrameExtraction === undefined
        ? []
        : collectRelationDemandTermsFromFactFrameCapture(
            context.supplementaryData.queryFactFrameExtraction
          )
  }).atoms;
  const content = candidate.entry.content.toLocaleLowerCase();
  const contentTokens = new Set(splitLexicalTokens(candidate.entry.content));
  const evidence = evidenceText(candidate, context);
  const evidenceTokens = new Set(splitLexicalTokens(evidence));
  const matches = atoms.flatMap((atom) => {
    const source = matchDemandAtom(
      atom, candidate, context, content, contentTokens, evidence, evidenceTokens
    );
    return source === null ? [] : [{ ...atom, source }];
  });
  const matchedKeys = new Set(matches.map((match) => demandAtomKey(match)));
  return Object.freeze({
    atoms: Object.freeze(atoms),
    matches: Object.freeze(matches.map((match) => Object.freeze(match))),
    unmatched: Object.freeze(atoms
      .filter((atom) => !matchedKeys.has(demandAtomKey(atom)))
      .map((atom) => Object.freeze(atom)))
  });
}

function matchDemandAtom(
  atom: Readonly<RecallSelectorDemandAtom>,
  candidate: FineAssessmentCandidate,
  context: FineAssessmentSelectionContext,
  content: string,
  contentTokens: ReadonlySet<string>,
  evidence: string,
  evidenceTokens: ReadonlySet<string>
): RecallSelectorDemandMatch["source"] | null {
  switch (atom.kind) {
    case "lexical_term":
      return matchesTextValue(atom.value, contentTokens, evidenceTokens);
    case "phrase":
      return content.includes(atom.value) ? "content"
        : evidence.includes(atom.value) ? "evidence" : null;
    case "temporal":
      return eventOverlapsQueryWindow(candidate, context) ? "temporal"
        : content.includes(atom.value) ? "content" : null;
    case "ordering":
      return candidate.entry.event_time_start === undefined ? null : "temporal";
    case "object_id":
      return candidate.entry.object_id.toLocaleLowerCase() === atom.value
        ? "key" : null;
    case "evidence_ref":
      return candidate.entry.evidence_refs
          .some((value) => value.toLocaleLowerCase() === atom.value)
        ? "evidence" : null;
    case "dimension":
      return String(candidate.entry.dimension).toLocaleLowerCase() === atom.value
        ? "key" : null;
    case "scope_class":
      return String(candidate.entry.scope_class).toLocaleLowerCase() === atom.value
        ? "key" : null;
    case "domain_tag":
      return (candidate.entry.domain_tags ?? [])
          .some((value) => value.toLocaleLowerCase() === atom.value)
        ? "key" : null;
    case "facet":
      return matchFacetKey(atom.value, candidate) ? "key" : null;
  }
}

function evidenceText(
  candidate: FineAssessmentCandidate,
  context: FineAssessmentSelectionContext
): string {
  if (!isWorkspaceMemoryCandidate(candidate)) return "";
  return context.supplementaryData.evidenceGistsByMemoryId[
    candidate.entry.object_id
  ]?.toLocaleLowerCase() ?? "";
}

function matchesTextValue(
  value: string,
  contentTokens: ReadonlySet<string>,
  evidenceTokens: ReadonlySet<string>
): RecallSelectorDemandMatch["source"] | null {
  if (matchesLexicalValue(value, contentTokens)) return "content";
  return matchesLexicalValue(value, evidenceTokens) ? "evidence" : null;
}

function matchesLexicalValue(
  value: string,
  contentTokens: ReadonlySet<string>
): boolean {
  const queryForms = lexicalForms(value);
  return [...contentTokens].some((token) =>
    [...lexicalForms(token)].some((form) => queryForms.has(form))
  );
}

function lexicalForms(value: string): ReadonlySet<string> {
  const normalized = value.replace(/[.]+$/u, "").toLocaleLowerCase();
  return new Set([normalized, ...foldLexicalMorphology(normalized)]);
}

function eventOverlapsQueryWindow(
  candidate: FineAssessmentCandidate,
  context: FineAssessmentSelectionContext
): boolean {
  const window = context.supplementaryData.queryTimeWindow;
  const start = Date.parse(candidate.entry.event_time_start ?? "");
  const end = Date.parse(candidate.entry.event_time_end ?? "") || start;
  return window !== undefined && Number.isFinite(start) &&
    Math.min(start, end) <= window.endMs && Math.max(start, end) >= window.startMs;
}

function matchFacetKey(facet: string, candidate: FineAssessmentCandidate): boolean {
  const fields = [
    ...(candidate.entry.domain_tags ?? []),
    ...(candidate.entry.canonical_entities ?? []),
    candidate.entry.preference_subject,
    candidate.entry.preference_predicate,
    candidate.entry.preference_object,
    candidate.entry.preference_category
  ];
  return fields.some((value) => value?.toLocaleLowerCase().includes(facet));
}

function demandAtomKey(atom: Readonly<RecallSelectorDemandAtom>): string {
  return atom.id;
}

function buildEvidenceObservation(
  candidate: FineAssessmentCandidate,
  support: Readonly<RecallCandidateAnswerSupport> | undefined,
  observations: readonly Readonly<RecallAnswerSupportObservation>[]
) {
  const documentIdentity = normalizedString(candidate.evidenceDocumentIdentity);
  const directness = resolveEvidenceDirectness(candidate, documentIdentity);
  const authority = resolveEvidenceAuthority(candidate, support);
  const behaviorEligible = support?.authority?.behavior_eligible === true ||
    observations.some((observation) => observation.behavior_eligible);
  return Object.freeze({
    directness,
    authority,
    validity: resolveEvidenceValidity(directness, behaviorEligible),
    source_role: candidate.evidenceSourceRole ?? null,
    document_identity: documentIdentity,
    evidence_refs: Object.freeze([...candidate.entry.evidence_refs]),
    event_status: resolveEventStatus(support?.authority?.event_status, observations),
    preference_polarity: candidate.entry.preference_polarity ?? null
  });
}

function resolveEvidenceDirectness(
  candidate: FineAssessmentCandidate,
  documentIdentity: string | null
): RecallSelectorEvidenceDirectness {
  if ((candidate.objectKind ?? "memory_entry") === "evidence_capsule") {
    return documentIdentity === null ? "unresolved" : "direct_document";
  }
  return candidate.entry.evidence_refs.length > 0 ? "referenced" : "none";
}

function resolveEvidenceAuthority(
  candidate: FineAssessmentCandidate,
  support: Readonly<RecallCandidateAnswerSupport> | undefined
): RecallSelectorEvidenceAuthority {
  if (support?.authority?.provenance_status === "verified_user_assertion") {
    return "verified_user_assertion";
  }
  const source = candidate.verifiedUserSupportSource;
  if (source?.projection_kind === "atomic_assertion") return "verified_user_assertion";
  if (source !== undefined) return "verified_user_projection";
  return candidate.entry.evidence_refs.length > 0 ||
    (candidate.objectKind ?? "memory_entry") === "evidence_capsule"
    ? "unverified"
    : "none";
}

function resolveEvidenceValidity(
  directness: RecallSelectorEvidenceDirectness,
  behaviorEligible: boolean
): RecallSelectorEvidenceValidity {
  if (behaviorEligible) return "behavior_eligible";
  if (directness === "direct_document") return "recall_qualified";
  if (directness === "referenced") return "observed_reference";
  return directness === "unresolved" ? "unresolved" : "none";
}

function resolveEventStatus(
  authorityStatus: RecallSelectorEventStatus | undefined,
  observations: readonly Readonly<RecallAnswerSupportObservation>[]
): RecallSelectorEventStatus {
  return authorityStatus ?? observations[0]?.event_status ?? "not_observed";
}

function buildTemporalObservation(
  candidate: FineAssessmentCandidate,
  support: Readonly<RecallCandidateAnswerSupport> | undefined,
  observations: readonly Readonly<RecallAnswerSupportObservation>[]
) {
  const compatibility: RecallSelectorTemporalCompatibility =
    support?.authority?.time_status ?? observations[0]?.time_status ?? "not_observed";
  return Object.freeze({
    compatibility,
    event_time_start: candidate.entry.event_time_start ?? null,
    event_time_end: candidate.entry.event_time_end ?? null,
    valid_from: candidate.entry.valid_from ?? null,
    valid_to: candidate.entry.valid_to ?? null,
    time_precision: candidate.entry.time_precision ?? null,
    time_source: candidate.entry.time_source ?? null
  });
}

function buildPathObservation(
  candidate: FineAssessmentCandidate,
  context: FineAssessmentSelectionContext
): RecallCandidateSelectorObservation["path"] {
  const inflow = context.supplementaryData.pathInflowByTarget;
  const availability = context.supplementaryData.pathInflowAvailability;
  if (!isWorkspaceMemoryCandidate(candidate)) {
    return Object.freeze({ status: "not_observed", receipts: Object.freeze([]) });
  }
  if (availability === "unavailable") {
    return Object.freeze({ status: "unavailable", receipts: Object.freeze([]) });
  }
  if (inflow === undefined || availability === "not_observed") {
    return Object.freeze({ status: "not_observed", receipts: Object.freeze([]) });
  }
  const receipts = Object.freeze(
    (inflow[candidate.entry.object_id] ?? []).map(buildPathReceipt).sort(comparePathReceipts)
  );
  const status = receipts.length === 0
    ? "none"
    : receipts.every((receipt) => receipt.receipt_status === "complete")
      ? "complete"
      : "partial";
  return Object.freeze({ status, receipts });
}

function buildPathReceipt(edge: Readonly<PathInflowEdge>): Readonly<RecallSelectorPathReceipt> {
  const pathId = normalizedString(edge.pathId);
  const relationKind = normalizedString(edge.relationKind);
  const sourceObjectId = normalizedString(edge.seedObjectId);
  const targetObjectId = normalizedString(edge.targetObjectId);
  const sourceVersion = normalizedString(edge.pathSourceVersion);
  const sourceAnchor = readAnchor(edge.seedAnchor);
  const targetAnchor = readAnchor(edge.targetAnchor);
  const edgeConductance = Number.isFinite(edge.weight) ? edge.weight : null;
  const complete = pathId !== null && relationKind !== null && sourceObjectId !== null &&
    targetObjectId !== null && sourceVersion !== null && sourceAnchor !== null &&
    targetAnchor !== null && edgeConductance !== null;
  return Object.freeze({
    receipt_status: complete ? "complete" : "partial",
    path_id: pathId,
    relation_kind: relationKind,
    source_object_id: sourceObjectId,
    target_object_id: targetObjectId,
    source_anchor: sourceAnchor,
    target_anchor: targetAnchor,
    source_version: sourceVersion,
    edge_conductance: edgeConductance
  });
}

function readAnchor(anchor: Readonly<PathAnchorRef> | undefined): Readonly<PathAnchorRef> | null {
  if (anchor === undefined) return null;
  const parsed = PathAnchorRefSchema.safeParse(anchor);
  return parsed.success ? parsed.data : null;
}

function normalizedString(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length === 0 ? null : trimmed;
}

function comparePathReceipts(
  left: Readonly<RecallSelectorPathReceipt>,
  right: Readonly<RecallSelectorPathReceipt>
): number {
  const leftKey = pathReceiptSortKey(left);
  const rightKey = pathReceiptSortKey(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function pathReceiptSortKey(receipt: Readonly<RecallSelectorPathReceipt>): string {
  return [
    receipt.receipt_status,
    receipt.path_id,
    receipt.relation_kind,
    receipt.source_object_id,
    receipt.target_object_id,
    receipt.source_version,
    anchorSortKey(receipt.source_anchor),
    anchorSortKey(receipt.target_anchor),
    receipt.edge_conductance === null ? null : normalizeNumber(receipt.edge_conductance)
  ].map((value) => value ?? "").join("\u0000");
}

function anchorSortKey(anchor: Readonly<PathAnchorRef> | null): string | null {
  if (anchor === null) return null;
  switch (anchor.kind) {
    case "object":
      return `object:${anchor.object_id}`;
    case "object_facet":
      return `object_facet:${anchor.object_id}:${anchor.facet_key}`;
    case "obligation":
      return `obligation:${anchor.source_object_id}:${anchor.obligation_digest}`;
    case "risk_concern":
      return `risk_concern:${anchor.source_object_id}:${anchor.concern_digest}`;
    case "time_concern":
      return `time_concern:${anchor.source_object_id}:${anchor.window_digest}`;
  }
}

function normalizeNumber(value: number): string {
  return Object.is(value, -0) ? "0" : String(value);
}
