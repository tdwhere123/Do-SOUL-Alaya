import {
  MemoryDimension,
  ScopeClass,
  SourceKind,
  type CandidateMemorySignal,
  type ClaimKind,
  type EnforcementLevel as EnforcementLevelValue,
  type FormationKind,
  type MemoryDimension as MemoryDimensionValue,
  type OriginTier,
  type PrecedenceBasis as PrecedenceBasisValue,
  type ScopeClass as ScopeClassValue,
  type SourceKind as SourceKindValue,
  type SynthesisType
} from "@do-soul/alaya-protocol";

export function toScopeClass(scopeHint: string | null): ScopeClassValue {
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

export function toMemoryDimension(objectKind: string): MemoryDimensionValue {
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

export function toSourceKind(source: CandidateMemorySignal["source"]): SourceKindValue {
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

export function toFormationKind(signal: CandidateMemorySignal): FormationKind {
  switch (signal.source) {
    case "user_seed":
      return "explicit";
    case "import":
      return "imported";
    case "model_tool":
      // invariant: model_tool signals with source_memory_refs derive from
      // existing memories; plain model emissions without refs are inferences.
      return signal.source_memory_refs.length > 0 ? "derived" : "inferred";
    case "garden_compile":
    default:
      return "extracted";
  }
}

export function toClaimKind(objectKind: string): ClaimKind {
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

export function toOriginTier(source: CandidateMemorySignal["source"]): OriginTier {
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

export function toSynthesisType(): SynthesisType {
  return "cross_evidence";
}

// invariant: producer-side rule mirrors the canonical helper
// `derivePrecedenceBasis` in packages/core/src/governance/claim-service.ts. Priority
// (highest wins): user_override > authority > recency > evidence_strength.
// Garden cannot import from packages/core (invariant §6), so the rule is
// duplicated here with the cross-file anchor below; both producers stay
// in lockstep through identical truth-table tests.
// see also: packages/core/src/governance/claim-service.ts derivePrecedenceBasis
export function pickPrecedenceBasis(
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
