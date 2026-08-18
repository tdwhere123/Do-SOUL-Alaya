import { createHash } from "node:crypto";
import {
  verifyOpenSemanticFactorFormationCapture,
  type OpenSemanticFactor,
  type OpenSemanticFactorFormationCapture,
  type OpenSemanticFactorGraph,
  type OpenSemanticProposition
} from "@do-soul/alaya-protocol";
import { digestRecallFieldIdentity, type RecallFieldDigest } from
  "../field-identity.js";
import {
  enumerateOpenSemanticArgumentAlignments,
  type OpenSemanticFactorArgumentMapping
} from "./argument-alignment.js";
import {
  openSemanticFactorSetsOverlap,
  openSemanticFactorsOverlap
} from "./factor-identity.js";
import { compareText } from "../../../shared/compare-text.js";

export type {
  OpenSemanticFactorAlignmentOperator,
  OpenSemanticFactorArgumentMapping
} from "./argument-alignment.js";

export const OPEN_SEMANTIC_FACTOR_COMPATIBILITY_OPERATOR_ID =
  "open_semantic_factor_compatibility_v1";

export type OpenSemanticPropositionMatch = Readonly<{
  readonly query_proposition_id: string;
  readonly evidence_proposition_id: string;
  readonly predicate_alignment: Readonly<{
    readonly query_factor_id: string;
    readonly evidence_factor_id: string;
    readonly operator_id: "exact_semantic_identity_v1";
  }>;
  readonly argument_mappings: readonly Readonly<OpenSemanticFactorArgumentMapping>[];
}>;

export type OpenSemanticFactorCompatibilityStatus =
  | "compatible"
  | "incompatible"
  | "ineligible"
  | "unavailable"
  | "rejected";

export type OpenSemanticFactorCompatibilityReceipt = Readonly<{
  readonly schema_version: 1;
  readonly operator_id: typeof OPEN_SEMANTIC_FACTOR_COMPATIBILITY_OPERATOR_ID;
  readonly status: OpenSemanticFactorCompatibilityStatus;
  readonly evidence_capture_digest: string;
  readonly query_capture_digest: string;
  readonly evidence_graph_digest: RecallFieldDigest | null;
  readonly query_graph_digest: RecallFieldDigest | null;
  readonly query_proposition_count: number;
  readonly matched_query_proposition_count: number;
  readonly proposition_match_candidates: readonly Readonly<OpenSemanticPropositionMatch>[];
  readonly proposition_matches: readonly Readonly<OpenSemanticPropositionMatch>[];
  readonly receipt_digest: RecallFieldDigest;
}>;

export function materializeOpenSemanticFactorCompatibility(params: Readonly<{
  readonly evidence_capture: Readonly<OpenSemanticFactorFormationCapture>;
  readonly query_capture: Readonly<OpenSemanticFactorFormationCapture>;
}>): OpenSemanticFactorCompatibilityReceipt {
  const evidence = verifyCapture(params.evidence_capture);
  const query = verifyCapture(params.query_capture);
  const unavailableStatus = resolveUnavailableStatus(evidence.status, query.status);
  if (unavailableStatus !== null || evidence.graph === null || query.graph === null) {
    return freezeReceipt(unavailableStatus ?? "unavailable", evidence, query, [], [], 0);
  }
  if (evidence.graph.source_kind !== "evidence" || query.graph.source_kind !== "query") {
    throw new Error("open semantic factor compatibility source kind mismatch");
  }
  const { candidates, matches } = matchGraphs(evidence.graph, query.graph);
  const matchedQueryPropositions = new Set(
    matches.map((match) => match.query_proposition_id)
  );
  // All-must-match treated partial overlap as absent fuel.
  const compatible = matchedQueryPropositions.size > 0;
  return freezeReceipt(
    compatible ? "compatible" : "incompatible",
    evidence,
    query,
    candidates,
    matches,
    query.graph.propositions.length
  );
}

export function verifyOpenSemanticFactorCompatibilityReceipt(params: Readonly<{
  readonly receipt: Readonly<OpenSemanticFactorCompatibilityReceipt>;
  readonly evidence_capture: Readonly<OpenSemanticFactorFormationCapture>;
  readonly query_capture: Readonly<OpenSemanticFactorFormationCapture>;
}>): OpenSemanticFactorCompatibilityReceipt {
  const expected = materializeOpenSemanticFactorCompatibility(params);
  if (expected.receipt_digest !== params.receipt.receipt_digest ||
      digestReceiptBody(params.receipt) !== params.receipt.receipt_digest) {
    throw new Error("open semantic factor compatibility receipt digest mismatch");
  }
  return params.receipt as OpenSemanticFactorCompatibilityReceipt;
}

function matchGraphs(
  evidence: Readonly<OpenSemanticFactorGraph>,
  query: Readonly<OpenSemanticFactorGraph>
): Readonly<{
  readonly candidates: readonly Readonly<OpenSemanticPropositionMatch>[];
  readonly matches: readonly Readonly<OpenSemanticPropositionMatch>[];
}> {
  // Proposition search cannot produce matches without a shared factor token.
  if (!openSemanticFactorSetsOverlap(evidence.factors, query.factors)) {
    return Object.freeze({
      candidates: Object.freeze([]),
      matches: Object.freeze([])
    });
  }
  const evidenceFactors = indexFactors(evidence.factors);
  const queryFactors = indexFactors(query.factors);
  const matchCandidates = enumerateMatchCandidates({
    evidencePropositions: evidence.propositions,
    queryPropositions: query.propositions,
    evidenceFactors,
    queryFactors
  });
  const matches = selectConsistentMatches({
    candidates: matchCandidates,
    queryPropositions: [...query.propositions].sort(comparePropositions),
    queryIndex: 0,
    variableBindings: new Map(),
    usedEvidencePropositions: new Set()
  });
  return Object.freeze({
    candidates: Object.freeze(matchCandidates.map(({ match }) => match)),
    matches: Object.freeze(matches)
  });
}

type PropositionMatchCandidate = Readonly<{
  readonly match: OpenSemanticPropositionMatch;
  readonly variableBindings: ReadonlyMap<string, string>;
}>;

function selectConsistentMatches(params: Readonly<{
  readonly candidates: readonly PropositionMatchCandidate[];
  readonly queryPropositions: readonly Readonly<OpenSemanticProposition>[];
  readonly queryIndex: number;
  readonly variableBindings: ReadonlyMap<string, string>;
  readonly usedEvidencePropositions: ReadonlySet<string>;
}>): readonly Readonly<OpenSemanticPropositionMatch>[] {
  const queryProposition = params.queryPropositions[params.queryIndex];
  if (queryProposition === undefined) return Object.freeze([]);
  let best = selectConsistentMatches({ ...params, queryIndex: params.queryIndex + 1 });
  for (const candidate of params.candidates) {
    if (candidate.match.query_proposition_id !== queryProposition.proposition_id ||
        params.usedEvidencePropositions.has(candidate.match.evidence_proposition_id)) continue;
    const variableBindings = mergeVariableBindings(
      params.variableBindings,
      candidate.variableBindings
    );
    if (variableBindings === null) continue;
    const tail = selectConsistentMatches({
      ...params,
      queryIndex: params.queryIndex + 1,
      variableBindings,
      usedEvidencePropositions: new Set([
        ...params.usedEvidencePropositions,
        candidate.match.evidence_proposition_id
      ])
    });
    const selected = Object.freeze([candidate.match, ...tail]);
    if (selected.length > best.length) best = selected;
  }
  return best;
}

function enumerateMatchCandidates(params: Readonly<{
  readonly evidencePropositions: readonly Readonly<OpenSemanticProposition>[];
  readonly queryPropositions: readonly Readonly<OpenSemanticProposition>[];
  readonly evidenceFactors: ReadonlyMap<string, Readonly<OpenSemanticFactor>>;
  readonly queryFactors: ReadonlyMap<string, Readonly<OpenSemanticFactor>>;
}>): readonly PropositionMatchCandidate[] {
  const candidates = params.queryPropositions.flatMap((query) =>
    params.evidencePropositions.flatMap((evidence) =>
      matchPropositions({
        evidence,
        query,
        evidenceFactors: params.evidenceFactors,
        queryFactors: params.queryFactors,
        variableBindings: new Map()
      })
    )
  );
  return Object.freeze(candidates.sort((left, right) =>
    comparePropositionMatches(left.match, right.match)));
}

function mergeVariableBindings(
  current: ReadonlyMap<string, string>,
  additional: ReadonlyMap<string, string>
): ReadonlyMap<string, string> | null {
  const merged = new Map(current);
  for (const [variableId, semanticIdentity] of additional) {
    const prior = merged.get(variableId);
    if (prior !== undefined && prior !== semanticIdentity) return null;
    merged.set(variableId, semanticIdentity);
  }
  return merged;
}

function matchPropositions(params: Readonly<{
  readonly evidence: Readonly<OpenSemanticProposition>;
  readonly query: Readonly<OpenSemanticProposition>;
  readonly evidenceFactors: ReadonlyMap<string, Readonly<OpenSemanticFactor>>;
  readonly queryFactors: ReadonlyMap<string, Readonly<OpenSemanticFactor>>;
  readonly variableBindings: ReadonlyMap<string, string>;
}>): readonly PropositionMatchCandidate[] {
  const evidencePredicate = params.evidenceFactors.get(params.evidence.predicate_factor_id);
  const queryPredicate = params.queryFactors.get(params.query.predicate_factor_id);
  if (evidencePredicate === undefined || queryPredicate === undefined ||
      !openSemanticFactorsOverlap(evidencePredicate, queryPredicate)) return [];
  return enumerateOpenSemanticArgumentAlignments(params).map((alignment) => Object.freeze({
    match: Object.freeze({
      query_proposition_id: params.query.proposition_id,
      evidence_proposition_id: params.evidence.proposition_id,
      predicate_alignment: Object.freeze({
        query_factor_id: queryPredicate.factor_id,
        evidence_factor_id: evidencePredicate.factor_id,
        operator_id: "exact_semantic_identity_v1" as const
      }),
      argument_mappings: alignment.mappings
    }),
    variableBindings: alignment.variableBindings
  }));
}

function freezeReceipt(
  status: OpenSemanticFactorCompatibilityStatus,
  evidence: Readonly<OpenSemanticFactorFormationCapture>,
  query: Readonly<OpenSemanticFactorFormationCapture>,
  candidates: readonly Readonly<OpenSemanticPropositionMatch>[],
  matches: readonly Readonly<OpenSemanticPropositionMatch>[],
  queryPropositionCount: number
): OpenSemanticFactorCompatibilityReceipt {
  const body = Object.freeze({
    schema_version: 1 as const,
    operator_id: OPEN_SEMANTIC_FACTOR_COMPATIBILITY_OPERATOR_ID,
    status,
    evidence_capture_digest: evidence.capture_digest,
    query_capture_digest: query.capture_digest,
    evidence_graph_digest: evidence.graph === null
      ? null
      : digestRecallFieldIdentity(evidence.graph),
    query_graph_digest: query.graph === null
      ? null
      : digestRecallFieldIdentity(query.graph),
    query_proposition_count: queryPropositionCount,
    matched_query_proposition_count: matches.length,
    proposition_match_candidates: Object.freeze([...candidates]),
    proposition_matches: Object.freeze([...matches])
  });
  return Object.freeze({ ...body, receipt_digest: digestRecallFieldIdentity(body) });
}

function digestReceiptBody(
  receipt: Readonly<OpenSemanticFactorCompatibilityReceipt>
): RecallFieldDigest {
  const { receipt_digest: _digest, ...body } = receipt;
  return digestRecallFieldIdentity(body);
}

function resolveUnavailableStatus(
  evidence: OpenSemanticFactorFormationCapture["status"],
  query: OpenSemanticFactorFormationCapture["status"]
): Exclude<OpenSemanticFactorCompatibilityStatus, "compatible" | "incompatible"> | null {
  if (evidence === "rejected" || query === "rejected") return "rejected";
  if (evidence === "ineligible" || query === "ineligible") return "ineligible";
  if (evidence === "unavailable" || query === "unavailable") return "unavailable";
  return null;
}

function verifyCapture(
  capture: Readonly<OpenSemanticFactorFormationCapture>
): OpenSemanticFactorFormationCapture {
  return verifyOpenSemanticFactorFormationCapture(capture, sha256);
}

function indexFactors(
  factors: readonly Readonly<OpenSemanticFactor>[]
): ReadonlyMap<string, Readonly<OpenSemanticFactor>> {
  return new Map(factors.map((factor) => [factor.factor_id, factor]));
}

function comparePropositions(
  left: Readonly<OpenSemanticProposition>,
  right: Readonly<OpenSemanticProposition>
): number {
  return compareText(left.proposition_id, right.proposition_id);
}

function comparePropositionMatches(
  left: Readonly<OpenSemanticPropositionMatch>,
  right: Readonly<OpenSemanticPropositionMatch>
): number {
  return compareText(left.query_proposition_id, right.query_proposition_id) ||
    compareText(left.evidence_proposition_id, right.evidence_proposition_id);
}


function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
