import {
  EvidenceHealthState,
  MemoryDimension,
  PathGovernanceClass,
  ScopeClass,
  SourceKind,
  StorageTier,
  type CandidateMemorySignal,
  type ClaimKind,
  type EnforcementLevel as EnforcementLevelValue,
  type EvidenceCapsule,
  type EvidenceHealthState as EvidenceHealthStateValue,
  type EvidenceKind as EvidenceKindValue,
  type FormationKind,
  type MemoryDimension as MemoryDimensionValue,
  type OriginTier,
  type PrecedenceBasis as PrecedenceBasisValue,
  type ScopeClass as ScopeClassValue,
  type SourceKind as SourceKindValue,
  type SynthesisType
} from "@do-soul/alaya-protocol";
import { readSchemaGroundedContent } from "../schema-grounding.js";
import {
  type ClaimMaterializationInput,
  type EvidenceMaterializationInput,
  type MaterializationTarget,
  type MemoryMaterializationInput,
  type PathRelationProposalPayload,
  type SignalRefSeedSpec,
  type SynthesisMaterializationInput
} from "./contracts.js";
import { SIGNAL_REF_SEED_SPECS } from "./signal-ref-seeds.js";

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
    case "activity":
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

export function buildTimeConcernPathRelationProposal(
  targetObjectId: string,
  timeConcern: TimeConcernPayload
): PathRelationProposalPayload {
  return {
    target_anchor: {
      kind: "time_concern",
      source_object_id: targetObjectId,
      window_digest: timeConcern.window_digest
    },
    constitution: {
      relation_kind: "time_concern",
      why_this_relation_exists: [`matched temporal expression: ${timeConcern.matched_text}`]
    },
    effect_vector: {
      salience: 0.6,
      recall_bias: 0.7,
      verification_bias: 0.1,
      unfinishedness_bias: 0,
      default_manifestation_preference: "lens_entry"
    },
    plasticity_state: {
      strength: 0.4,
      direction_bias: "source_to_target",
      stability_class: "normal",
      support_events_count: 1,
      contradiction_events_count: 0
    },
    lifecycle: {
      status: "active",
      retirement_rule: "janitor_ttl_low_strength"
    },
    legitimacy: {
      evidence_basis: ["garden:time_concern"],
      governance_class: PathGovernanceClass.RECALL_ALLOWED
    }
  };
}

export function buildFailedSignalRefPathRelationProposal(params: {
  readonly newObjectId: string;
  readonly failedRef: string;
  readonly signal: CandidateMemorySignal;
  readonly spec: SignalRefSeedSpec;
  readonly thrownError: string | null;
}): PathRelationProposalPayload {
  const recallBias = params.spec.recallBiasSign * params.spec.recallBiasMagnitude;
  const why = [
    `${params.spec.signalRefsKey} on candidate signal ${params.signal.signal_id}`,
    `run=${params.signal.run_id}`,
    `path candidate mint failed for target_anchor=${params.failedRef}`
  ];
  if (params.thrownError !== null) {
    why.push(`submitCandidate threw: ${params.thrownError}`);
  }

  return {
    target_anchor: {
      kind: "object",
      object_id: params.failedRef
    },
    constitution: {
      relation_kind: params.spec.relationKind,
      why_this_relation_exists: why
    },
    effect_vector: {
      salience: params.spec.initialStrength,
      recall_bias: recallBias,
      verification_bias: 0,
      unfinishedness_bias: 0,
      default_manifestation_preference: "lens_entry"
    },
    plasticity_state: {
      strength: params.spec.initialStrength,
      direction_bias: "source_to_target",
      stability_class: "volatile",
      support_events_count: 1,
      contradiction_events_count: 0
    },
    lifecycle: {
      status: "active",
      retirement_rule: "governance_reject_or_low_strength"
    },
    legitimacy: {
      evidence_basis: params.spec.evidenceBasis,
      governance_class: params.spec.governanceClass
    }
  };
}

export function buildFailedSignalRefPathRelationProposalReason(params: {
  readonly newObjectId: string;
  readonly failedRef: string;
  readonly signal: CandidateMemorySignal;
  readonly spec: SignalRefSeedSpec;
  readonly thrownError: string | null;
}): string {
  const base =
    `Persist failed ${params.spec.signalRefsKey} path_relation candidate ` +
    `${params.spec.relationKind} from ${params.newObjectId} to ${params.failedRef}. ` +
    `Source signal: ${params.signal.signal_id}.`;
  if (params.thrownError === null) {
    return base;
  }
  return `${base} submitCandidate error: ${params.thrownError}.`;
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
  opts?: { readonly fullTurnExcerpt?: boolean }
): EvidenceMaterializationInput {
  // When fullTurnExcerpt is on (opt-in, default off), widen the searchable
  // evidence excerpt/gist to the full source turn the signal carries
  // (`full_turn_content`) so evidence_capsule_fts holds the query vocabulary that
  // distillation + the narrow matched_text span drop. Lifts LongMemEval
  // preference any-gold recall 77% -> 97% by letting evidence_fts surface a
  // memory whose distilled content missed the query. Default keeps the
  // matched_text-span excerpt unchanged.
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
    physical_anchor: buildSignalPhysicalAnchor(signal),
    evidence_health_state: computeEvidenceHealthState(signal),
    gist: appendSummarySuffix(excerpt, summarySuffix),
    excerpt,
    source_hash: null,
    run_id: signal.run_id,
    workspace_id: signal.workspace_id,
    surface_id: signal.surface_id
  };
}

function buildSignalPhysicalAnchor(signal: CandidateMemorySignal): EvidenceCapsule["physical_anchor"] {
  const artifactRef = signal.evidence_refs.find((ref) => ref.trim().length > 0)?.trim() ?? null;
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
  enqueueEnrichment?: MemoryMaterializationInput["enqueueEnrichment"]
): MemoryMaterializationInput {
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
    content: buildDistilledFact(signal),
    domain_tags: signal.domain_tags,
    evidence_refs: evidenceRefs,
    workspace_id: signal.workspace_id,
    run_id: signal.run_id,
    surface_id: signal.surface_id,
    storage_tier: StorageTier.HOT,
    ...(enqueueEnrichment === undefined ? {} : { enqueueEnrichment })
  };
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

// invariant: producer-side rule mirrors the canonical helper
// `derivePrecedenceBasis` in packages/core/src/governance/claim-service.ts. Priority
// (highest wins): user_override > authority > recency > evidence_strength.
// Garden cannot import from packages/core (invariant §6), so the rule is
// duplicated here with the cross-file anchor below; both producers stay
// in lockstep through identical truth-table tests.
// see also: packages/core/src/governance/claim-service.ts derivePrecedenceBasis
function pickPrecedenceBasis(
  signal: CandidateMemorySignal,
  enforcementLevel: EnforcementLevelValue
): PrecedenceBasisValue {
  if (signal.source === "user_seed" || hasUserOverrideMarker(signal)) {
    return "user_override";
  }
  if (enforcementLevel === "strict") {
    return "authority";
  }
  if (hasSupersedeIntent(signal)) {
    return "recency";
  }
  return "evidence_strength";
}

function hasUserOverrideMarker(signal: CandidateMemorySignal): boolean {
  return signal.raw_payload.user_override === true;
}

function hasSupersedeIntent(signal: CandidateMemorySignal): boolean {
  return signal.supersedes_refs.some((ref) => ref.trim().length > 0);
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
    source_memory_refs: [],
    workspace_id: signal.workspace_id,
    run_id: signal.run_id
  };
}

function toScopeClass(scopeHint: string | null): ScopeClassValue {
  switch (scopeHint) {
    case ScopeClass.GLOBAL_CORE:
      return ScopeClass.GLOBAL_CORE;
    case ScopeClass.GLOBAL_DOMAIN:
      return ScopeClass.GLOBAL_DOMAIN;
    case ScopeClass.PROJECT:
    default:
      return ScopeClass.PROJECT;
  }
}

function toMemoryDimension(objectKind: string): MemoryDimensionValue {
  switch (objectKind) {
    case MemoryDimension.PREFERENCE:
      return MemoryDimension.PREFERENCE;
    case MemoryDimension.CONSTRAINT:
      return MemoryDimension.CONSTRAINT;
    case MemoryDimension.DECISION:
      return MemoryDimension.DECISION;
    case MemoryDimension.PROCEDURE:
      return MemoryDimension.PROCEDURE;
    case MemoryDimension.HAZARD:
      return MemoryDimension.HAZARD;
    case MemoryDimension.GLOSSARY:
      return MemoryDimension.GLOSSARY;
    case MemoryDimension.EPISODE:
      return MemoryDimension.EPISODE;
    default:
      return MemoryDimension.FACT;
  }
}

function toSourceKind(source: CandidateMemorySignal["source"]): SourceKindValue {
  switch (source) {
    case "user_seed":
      return SourceKind.SEED;
    case "import":
      return SourceKind.IMPORT;
    case "model_tool":
    case "garden_compile":
    default:
      return SourceKind.COMPILER;
  }
}

function toFormationKind(signal: CandidateMemorySignal): FormationKind {
  switch (signal.source) {
    case "user_seed":
      return "explicit";
    case "import":
      return "imported";
    case "model_tool":
      // model_tool signals carrying source_memory_refs build on top of
      // existing memories (a derivation); plain LLM emissions without
      // such refs are inferences.
      return signal.source_memory_refs.length > 0 ? "derived" : "inferred";
    case "garden_compile":
    default:
      return "extracted";
  }
}

function toClaimKind(objectKind: string): ClaimKind {
  switch (objectKind) {
    case "preference":
      return "preference";
    case "decision":
      return "decision";
    case "procedure":
      return "procedure";
    case "hazard":
      return "hazard";
    case "factual_policy":
      return "factual_policy";
    case "exception":
      return "exception";
    case "glossary":
      return "glossary";
    case "episode":
      return "episode";
    case "constraint":
    default:
      return "constraint";
  }
}

function toOriginTier(source: CandidateMemorySignal["source"]): OriginTier {
  switch (source) {
    case "user_seed":
      return "seed";
    case "import":
      return "imported";
    case "model_tool":
    case "garden_compile":
    default:
      return "compiler_extracted";
  }
}

function toSynthesisType(): SynthesisType {
  return "cross_evidence";
}

function buildTopicKey(signal: CandidateMemorySignal): string {
  const primaryTag = signal.domain_tags[0] ?? "signal";
  const basis = `${primaryTag}_${signal.object_kind}`.toLowerCase();
  const topicKey = basis.replace(/[^a-z0-9_.-]/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");

  return topicKey.length === 0 ? `signal_${signal.signal_id}` : topicKey;
}

function buildSignalSummary(signal: CandidateMemorySignal): string {
  const schemaGroundedContent = readSchemaGroundedContent(signal);
  if (schemaGroundedContent !== null) {
    return schemaGroundedContent;
  }

  const excerpt = signal.raw_payload.excerpt;
  if (typeof excerpt === "string" && excerpt.trim().length > 0) {
    return excerpt.trim();
  }

  const matchedText = signal.raw_payload.matched_text;
  if (typeof matchedText === "string" && matchedText.trim().length > 0) {
    return matchedText.trim();
  }

  return `Signal ${signal.signal_id} (${signal.signal_kind})`;
}

// invariant: MemoryEntry.content / Claim.proposition_digest /
// Synthesis.summary store a distilled fact, not raw turn. Raw turn lives
// in EvidenceCapsule.gist / .excerpt. Caller (LLM / user / bench harness)
// may supply raw_payload.distilled_fact directly; otherwise a rule-based
// fallback takes the first two sentences capped at DISTILLED_FACT_MAX_CHARS.
// Single source of truth for the distilled-fact length budget: the
// official-API garden provider clamps raw_payload.distilled_fact to this
// same constant. see also: garden/compute-provider.ts.
// invariant: kept <= AUDIT_DROPPED_CONTENT_MAX_CHARS (500) in
// packages/core/src/governance/reconciliation-service.ts so a dropped fact stays
// fully reconstructable from the reconciliation audit row.
export const DISTILLED_FACT_MAX_CHARS = 500;
const DISTILLED_FACT_MAX_SENTENCES = 2;

export function buildDistilledFact(signal: CandidateMemorySignal): string {
  const providedDistilled = signal.raw_payload.distilled_fact;
  if (typeof providedDistilled === "string") {
    const trimmed = providedDistilled.trim();
    if (trimmed.length > 0) {
      // A caller-supplied distilled_fact is already a resolved
      // one-assertion fact; use it verbatim when within cap. The "..."
      // truncation belongs only to ruleDistillFromRaw (raw -> distilled).
      // An over-cap supplied fact is not the normal path once the
      // provider clamps to DISTILLED_FACT_MAX_CHARS — clamp defensively.
      return trimmed.length <= DISTILLED_FACT_MAX_CHARS
        ? trimmed
        : trimmed.slice(0, DISTILLED_FACT_MAX_CHARS);
    }
  }
  return ruleDistillFromRaw(buildSignalSummary(signal));
}

// see also: buildDistilledFact — fallback path when caller does not supply
// raw_payload.distilled_fact. Sentence boundary scan covers Latin (.!?;)
// and CJK (。！？；) terminators; falls back to char-count slice when no
// terminator is found in the first 2x window.
function ruleDistillFromRaw(raw: string): string {
  const normalized = raw.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return "";
  }
  const sentenceRegex = /[^.!?;。！？；]+[.!?;。！？；]+/gu;
  const sentences = normalized.match(sentenceRegex) ?? [];
  // invariant: always take at most DISTILLED_FACT_MAX_SENTENCES sentences
  // even when the raw fits inside the char cap. Distilled fact is the
  // *first claim* of a turn, not the entire turn.
  if (sentences.length >= DISTILLED_FACT_MAX_SENTENCES) {
    const head = sentences.slice(0, DISTILLED_FACT_MAX_SENTENCES).join("").trim();
    if (head.length > 0 && head.length <= DISTILLED_FACT_MAX_CHARS) {
      return head;
    }
    return `${head.slice(0, DISTILLED_FACT_MAX_CHARS - 3)}...`;
  }
  if (normalized.length <= DISTILLED_FACT_MAX_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, DISTILLED_FACT_MAX_CHARS - 3)}...`;
}

function appendSummarySuffix(summary: string, suffix?: string): string {
  if (suffix === undefined) {
    return summary;
  }

  return `${summary} ${suffix}`;
}
