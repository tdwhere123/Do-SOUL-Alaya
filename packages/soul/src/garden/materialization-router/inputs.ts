import {
  EvidenceHealthState,
  StorageTier,
  type CandidateMemorySignal,
  type EnforcementLevel as EnforcementLevelValue,
  type EvidenceCapsule,
  type EvidenceHealthState as EvidenceHealthStateValue,
  type EvidenceKind as EvidenceKindValue
} from "@do-soul/alaya-protocol";
import { deriveFacetsFromText } from "../../shared/facet-keywords.js";
import {
  type ClaimMaterializationInput,
  type EvidenceMaterializationInput,
  type MaterializationTarget,
  type MemoryMaterializationInput,
  type SynthesisMaterializationInput
} from "./contracts.js";
import { SIGNAL_REF_SEED_SPECS } from "./signal-ref-seeds.js";
import { appendSummarySuffix, buildDistilledFact, buildSignalSummary, buildTopicKey } from "./distilled-fact.js";
import {
  pickPrecedenceBasis,
  toClaimKind,
  toFormationKind,
  toMemoryDimension,
  toOriginTier,
  toScopeClass,
  toSourceKind,
  toSynthesisType
} from "./input-conversions.js";
import { readMemoryTemporalProjectionPayload } from "./temporal-projection.js";
import { readMemoryPreferenceProfilePayload } from "./preference-projection.js";

export { DISTILLED_FACT_MAX_CHARS, buildDistilledFact } from "./distilled-fact.js";
export {
  buildTimeConcernPathRelationProposal,
  buildFailedSignalRefPathRelationProposal,
  buildFailedSignalRefPathRelationProposalReason
} from "./path-relation-inputs.js";

// invariant: routes a high-confidence potential_claim / potential_preference
// signal by its `object_kind`. Claim-capable dimensions are enumerated
// explicitly so truly unknown kinds fall through to null and the
// caller archives them as evidence_only — keeping the producer side
// from collapsing unrecognized labels into governance-actionable
// claims. Returns null only when the object_kind is outside every
// enumerated branch.
export function routeByObjectKind(objectKind: string): MaterializationTarget | null {
  switch (objectKind) {
    case "scope":
    case "task_scope":
    case "workflow_preference":
      return {
        kind: "deferred",
        route_target: "signal_only",
        routing_reason: `object_kind=${objectKind} -> signal_only (no projection beyond signal row)`
      };
    case "review_scope":
      return {
        kind: "evidence_only",
        route_target: "evidence_only",
        routing_reason: `object_kind=${objectKind} -> evidence_only`
      };
    case "workspace_status":
    case "project_state":
      return {
        kind: "evidence_only",
        route_target: "evidence_short_ttl",
        routing_reason: `object_kind=${objectKind} -> evidence_short_ttl`
      };
    case "preference":
    case "decision":
    case "constraint":
    case "procedure":
    case "hazard":
    case "factual_policy":
    case "exception":
    case "glossary":
    case "episode":
      return {
        kind: "memory_and_claim",
        route_target: "memory_and_claim_draft",
        routing_reason: `object_kind=${objectKind} -> memory_and_claim_draft (claim_status defaulted to draft by ClaimService)`
      };
    case "outcome":
    case "reference":
    case "task_state":
    case "fact":
    case "activity":
      return {
        kind: "evidence_only",
        route_target: "memory_entry_only",
        routing_reason: `object_kind=${objectKind} -> memory_entry_only (evidence + memory, no claim)`
      };
    default:
      return null;
  }
}

export interface TimeConcernPayload {
  readonly window_digest: string;
  readonly matched_text: string;
}

export function readTimeConcernPayload(rawPayload: CandidateMemorySignal["raw_payload"]): TimeConcernPayload | null {
  const timeConcern = rawPayload.time_concern;
  if (timeConcern === null || typeof timeConcern !== "object" || Array.isArray(timeConcern)) {
    return null;
  }
  const candidate = timeConcern as Record<string, unknown>;
  const windowDigest = normalizePayloadString(candidate.window_digest);
  const matchedText = normalizePayloadString(candidate.matched_text);
  if (windowDigest === null || matchedText === null) {
    return null;
  }
  return { window_digest: windowDigest, matched_text: matchedText };
}

export function readStringPayload(
  rawPayload: CandidateMemorySignal["raw_payload"],
  key: string
): string | null {
  return normalizePayloadString(rawPayload[key]);
}

function normalizePayloadString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
}

// True when raw_payload carries a non-empty preference_profile / temporal_projection; gates the projection-routing lift.
export function signalCarriesProjectionPayload(signal: CandidateMemorySignal): boolean {
  return (
    Object.keys(readMemoryPreferenceProfilePayload(signal.raw_payload)).length > 0 ||
    Object.keys(readMemoryTemporalProjectionPayload(signal.raw_payload)).length > 0
  );
}

export function hasMaterializableSignalMemoryRefs(signal: CandidateMemorySignal): boolean {
  return SIGNAL_REF_SEED_SPECS.some((spec) =>
    signal[spec.signalRefsKey].some((ref) => typeof ref === "string" && ref.trim().length > 0)
  );
}

export function collectMaterializableSignalMemoryRefs(signal: CandidateMemorySignal): readonly string[] {
  return SIGNAL_REF_SEED_SPECS.flatMap((spec) =>
    signal[spec.signalRefsKey].filter((ref) => typeof ref === "string" && ref.trim().length > 0)
  );
}

function computeEvidenceHealthState(signal: CandidateMemorySignal): EvidenceHealthStateValue {
  // Invariant #16: objects without evidence_refs must default to questionable,
  // not verified. Signals from local heuristics carry no supporting evidence.
  if (signal.evidence_refs.length === 0) {
    return EvidenceHealthState.QUESTIONABLE;
  }
  return EvidenceHealthState.VERIFIED;
}

// invariant: evidence_kind diversifies producer-side so the live ontology
// no longer collapses to 100% `inferred`. Mapping rules:
//   - user_seed / import sources → user_statement (operator-attested origin)
//   - signals carrying evidence_refs → external_reference (linked anchor)
//   - everything else (LLM / Garden compile) → inferred (default)
function pickEvidenceKind(signal: CandidateMemorySignal): EvidenceKindValue {
  if (signal.source === "user_seed" || signal.source === "import") {
    return "user_statement";
  }
  if (signal.evidence_refs.length > 0) {
    return "external_reference";
  }
  return "inferred";
}

export function buildEvidenceInput(
  signal: CandidateMemorySignal,
  summarySuffix?: string,
  opts?: { readonly fullTurnExcerpt?: boolean; readonly artifactRef?: string | null }
): EvidenceMaterializationInput {
  // fullTurnExcerpt widens the searchable excerpt/gist to the signal's full
  // source turn so evidence FTS keeps the query terms distillation drops;
  // otherwise the matched_text-span summary is used.
  const excerpt =
    opts?.fullTurnExcerpt === true
      ? (readStringPayload(signal.raw_payload, "full_turn_content") ??
         readStringPayload(signal.raw_payload, "bench_full_turn_content") ??
         buildSignalSummary(signal))
      : buildSignalSummary(signal);

  return {
    created_by: signal.source,
    evidence_kind: pickEvidenceKind(signal),
    semantic_anchor: {
      topic: buildTopicKey(signal),
      keywords: [...signal.domain_tags],
      summary: appendSummarySuffix(excerpt, summarySuffix)
    },
    event_anchor: {
      event_type: "soul.signal.emitted",
      event_id: null,
      occurred_at: signal.created_at
    },
    physical_anchor: buildSignalPhysicalAnchor(signal, opts?.artifactRef),
    evidence_health_state: computeEvidenceHealthState(signal),
    gist: appendSummarySuffix(excerpt, summarySuffix),
    excerpt,
    source_hash: null,
    run_id: signal.run_id,
    workspace_id: signal.workspace_id,
    surface_id: signal.surface_id
  };
}

function buildSignalPhysicalAnchor(
  signal: CandidateMemorySignal,
  artifactRefOverride?: string | null
): EvidenceCapsule["physical_anchor"] {
  const override = artifactRefOverride?.trim() ?? "";
  const artifactRef = override.length > 0
    ? override
    : signal.evidence_refs.find((ref) => ref.trim().length > 0)?.trim() ?? null;
  if (artifactRef === null) {
    return null;
  }

  return {
    file_path: null,
    line_range: null,
    symbol_name: null,
    artifact_ref: artifactRef
  };
}

export function buildMemoryInput(
  signal: CandidateMemorySignal,
  evidenceRefs: readonly string[],
  enqueueEnrichment?: MemoryMaterializationInput["enqueueEnrichment"],
  deriveFacetTags = false
): MemoryMaterializationInput {
  const temporalProjection = readMemoryTemporalProjectionPayload(signal.raw_payload);
  const preferenceProfile = readMemoryPreferenceProfilePayload(signal.raw_payload);
  const content = buildDistilledFact(signal);
  return {
    created_by: signal.source,
    dimension: toMemoryDimension(signal.object_kind),
    source_kind: toSourceKind(signal.source),
    formation_kind: toFormationKind(signal),
    scope_class: toScopeClass(signal.scope_hint),
    // invariant: MemoryEntry.content is the distilled fact, never raw turn.
    // Raw evidence lives in EvidenceCapsule.gist / .excerpt and is reached
    // via evidence_refs + soul.open_pointer. see buildDistilledFact for
    // caller-provided distilled_fact vs rule-based fallback.
    content,
    domain_tags: signal.domain_tags,
    evidence_refs: evidenceRefs,
    workspace_id: signal.workspace_id,
    run_id: signal.run_id,
    surface_id: signal.surface_id,
    storage_tier: StorageTier.HOT,
    ...temporalProjection,
    ...preferenceProfile,
    ...buildFacetTagsProjection(content, deriveFacetTags),
    ...buildCanonicalEntitiesProjection(signal),
    ...(enqueueEnrichment === undefined ? {} : { enqueueEnrichment })
  };
}

const MAX_CANONICAL_ENTITIES = 3;

// Threads the signal's canonical_entities (answer-selective recall key) onto the
// materialized memory_entry. Prefers the first-class signal field; falls back to
// the raw_payload echo so the bench seed path (which round-trips raw_payload, not
// the first-class field) persists it too. Empty → omit (byte-identical write).
function buildCanonicalEntitiesProjection(
  signal: CandidateMemorySignal
): Partial<Pick<MemoryMaterializationInput, "canonical_entities">> {
  const firstClass = signal.canonical_entities ?? [];
  const source = firstClass.length > 0 ? firstClass : readRawCanonicalEntities(signal.raw_payload);
  const entities = normalizeCanonicalEntities(source);
  return entities.length === 0 ? {} : { canonical_entities: entities };
}

function readRawCanonicalEntities(rawPayload: CandidateMemorySignal["raw_payload"]): readonly string[] {
  const value = rawPayload.canonical_entities;
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function normalizeCanonicalEntities(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    if (normalized.length === 0 || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(normalized);
    if (output.length >= MAX_CANONICAL_ENTITIES) {
      break;
    }
  }
  return output;
}

// Off → no facet_tags key (byte-identical to flat write); on → deterministic
// content-derived tags aligned to the read-side query facets via the same vocabulary.
export function buildFacetTagsProjection(
  content: string,
  deriveFacetTags: boolean
): Partial<Pick<MemoryMaterializationInput, "facet_tags">> {
  if (!deriveFacetTags) {
    return {};
  }
  const facets = deriveFacetsFromText(content);
  return facets.length === 0 ? {} : { facet_tags: facets.map((facet) => ({ facet })) };
}

// invariant: the enrich_pending no-drop intent carried into a memory-creating
// branch's create input — the truth boundary commits the row + marker
// atomically. see also: MaterializationRouter enqueueEnrichmentAfterCreate.
export function buildEnrichmentIntent(
  signal: CandidateMemorySignal
): NonNullable<MemoryMaterializationInput["enqueueEnrichment"]> {
  return { runId: signal.run_id, sourceSignalId: signal.signal_id };
}

export function buildClaimInput(
  signal: CandidateMemorySignal,
  evidenceRefs: readonly string[],
  sourceObjectRefs: readonly string[]
): ClaimMaterializationInput {
  const claimKind = toClaimKind(signal.object_kind);
  const enforcementLevel: EnforcementLevelValue =
    claimKind === "constraint" || claimKind === "factual_policy" ? "strict" : "preferred";

  return {
    created_by: signal.source,
    governance_subject_domain: `signal.${signal.object_kind}`,
    governance_subject_qualifiers: {
      workspace: signal.workspace_id,
      run: signal.run_id
    },
    claim_kind: claimKind,
    scope_class: toScopeClass(signal.scope_hint),
    enforcement_level: enforcementLevel,
    origin_tier: toOriginTier(signal.source),
    precedence_basis: pickPrecedenceBasis(signal, enforcementLevel),
    proposition_digest: buildDistilledFact(signal),
    evidence_refs: evidenceRefs,
    source_object_refs: sourceObjectRefs,
    workspace_id: signal.workspace_id
  };
}

export function buildSynthesisInput(
  signal: CandidateMemorySignal,
  evidenceRefs: readonly string[]
): SynthesisMaterializationInput {
  return {
    created_by: signal.source,
    topic_key: buildTopicKey(signal),
    synthesis_type: toSynthesisType(),
    summary: buildDistilledFact(signal),
    evidence_refs: evidenceRefs,
    source_memory_refs: collectSynthesisSourceMemoryRefs(signal),
    workspace_id: signal.workspace_id,
    run_id: signal.run_id
  };
}

function collectSynthesisSourceMemoryRefs(signal: CandidateMemorySignal): readonly string[] {
  return uniqueNonEmptyStrings(signal.source_memory_refs);
}

function uniqueNonEmptyStrings(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (normalized.length === 0 || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}
