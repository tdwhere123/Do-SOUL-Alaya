import { createHash } from "node:crypto";
import { z } from "zod";
import {
  parseSemanticReplayIdentity,
  semanticReplayIdentityDigest,
  type SemanticReplayIdentity
} from "./replay-authority.js";

export const SEMANTIC_ARTIFACT_SCHEMA_VERSION = 1;
export const SEMANTIC_ARTIFACT_KIND = "assertion_semantic_artifact_v1";
export const SEMANTIC_ARTIFACT_MAX_BYTES = 1_048_576;

const Hex64 = z.string().regex(/^[a-f0-9]{64}$/u);
const NonEmpty = z.string().trim().min(1);

export const SEMANTIC_ARTIFACT_STATES = [
  "missing",
  "reserved",
  "provider_backed",
  "deterministic_empty",
  "invalid",
  "quarantined"
] as const;

/** Writer-owned persisted states. exhaustive-empty has no minter on this substrate. */
export const MINTED_SEMANTIC_ADMISSION_STATES = [
  "provider_backed",
  "invalid",
  "quarantined"
] as const;

export type SemanticArtifactState = (typeof SEMANTIC_ARTIFACT_STATES)[number];

const LocatorSchema = z.object({
  contract_version: z.number().int().positive(),
  kind: z.literal("assertion_catalog"),
  assertion_id: z.number().int().positive(),
  start: z.number().int().nonnegative(),
  end: z.number().int().positive()
}).strict().readonly().refine((locator) => locator.end > locator.start, {
  message: "locator end must be greater than start"
});

const SourceBindingSchema = z.object({
  semanticKey: Hex64,
  sourceCorpusIdentity: Hex64,
  sourceTextDigest: Hex64,
  assertionTextDigest: Hex64,
  occurrenceIdentity: Hex64,
  locator: LocatorSchema,
  datasetRevision: NonEmpty.optional()
}).strict().readonly();

const DeterministicEmptyProofSchema = z.object({
  kind: z.literal("exhaustive_member_inspection"),
  formation_contract_version: z.number().int().positive(),
  assertion_id: z.number().int().positive(),
  legacy_cache_key_sha256: Hex64,
  request_sha256: Hex64,
  prompt_sha256: Hex64,
  completion_witness_sha256: Hex64,
  sealed_entry_sha256: Hex64
}).strict();

const ProviderProvenanceSchema = z.object({
  provider_url_sha256: Hex64,
  request_profile: NonEmpty,
  model_id: NonEmpty,
  transport_model_id: NonEmpty
}).strict().readonly();

const RawEvidenceBindingSchema = z.object({
  pack_identity: Hex64,
  request_sha256: Hex64,
  source_corpus_identity: Hex64,
  replay_identity_digest: Hex64
}).strict().readonly();

const ReplayIdentitySchema = z.custom<SemanticReplayIdentity>((value) => {
  try {
    parseSemanticReplayIdentity(value);
    return true;
  } catch {
    return false;
  }
}, "semantic replay identity is invalid").transform(parseSemanticReplayIdentity);

const LegacyConversionWitnessSchema = z.object({
  cache_key: Hex64,
  request_sha256: Hex64,
  prompt_sha256: Hex64,
  completion_witness_sha256: Hex64,
  sealed_entry_sha256: Hex64,
  source_authority_sha256: Hex64,
  source_manifest_sha256: Hex64,
  raw_json_sha256: Hex64,
  response_metadata_sha256: Hex64,
  transport_provenance_sha256: Hex64
}).strict().readonly();

export const SemanticArtifactSchema = z.object({
  schema_version: z.literal(SEMANTIC_ARTIFACT_SCHEMA_VERSION),
  kind: z.literal(SEMANTIC_ARTIFACT_KIND),
  semantic_key: Hex64,
  semantic_contract: NonEmpty,
  capability: NonEmpty,
  capability_set: z.array(NonEmpty).min(1).readonly(),
  model_family: NonEmpty,
  model_id: NonEmpty,
  admission_state: z.enum(["provider_backed", "deterministic_empty", "invalid", "quarantined"]),
  source_bindings: z.array(SourceBindingSchema).min(1).readonly(),
  provider_provenance: ProviderProvenanceSchema.optional(),
  replay_identity: ReplayIdentitySchema,
  replay_identity_digest: Hex64,
  legacy_conversion_witness: LegacyConversionWitnessSchema.optional(),
  raw_evidence_binding: RawEvidenceBindingSchema.optional(),
  raw_response_digest: Hex64.optional(),
  deterministic_empty_proof: DeterministicEmptyProofSchema.optional(),
  quarantine_reason: NonEmpty.optional(),
  artifact_digest: Hex64
}).strict().readonly().superRefine((artifact, ctx) => {
  if (artifact.capability_set.includes(artifact.capability) === false) {
    ctx.addIssue({ code: "custom", message: "capability must be a member of capability_set" });
  }
  if (artifact.source_bindings.some((binding) => binding.semanticKey !== artifact.semantic_key)) {
    ctx.addIssue({ code: "custom", message: "source binding semantic key mismatch" });
  }
  if (semanticReplayIdentityDigest(artifact.replay_identity) !== artifact.replay_identity_digest) {
    ctx.addIssue({ code: "custom", message: "replay_identity_digest mismatch" });
  }
  if (artifact.raw_evidence_binding !== undefined &&
      artifact.raw_evidence_binding.replay_identity_digest !== artifact.replay_identity_digest) {
    ctx.addIssue({ code: "custom", message: "raw evidence replay identity mismatch" });
  }
  if (artifact.admission_state === "provider_backed") {
    if (artifact.raw_response_digest === undefined) {
      ctx.addIssue({ code: "custom", message: "provider_backed requires raw_response_digest" });
    }
    if (artifact.provider_provenance === undefined) {
      ctx.addIssue({ code: "custom", message: "provider_backed requires provenance" });
    }
    if (artifact.raw_evidence_binding === undefined &&
        artifact.legacy_conversion_witness === undefined) {
      ctx.addIssue({ code: "custom", message: "provider_backed requires raw evidence binding" });
    }
    if (artifact.deterministic_empty_proof !== undefined) {
      ctx.addIssue({ code: "custom", message: "provider_backed cannot carry empty proof" });
    }
  }
  if (artifact.admission_state === "deterministic_empty") {
    if (artifact.deterministic_empty_proof === undefined) {
      ctx.addIssue({ code: "custom", message: "deterministic_empty requires exhaustive proof" });
    }
  }
  if (artifact.admission_state === "quarantined" && artifact.quarantine_reason === undefined) {
    ctx.addIssue({ code: "custom", message: "quarantined requires reason" });
  }
  const { artifact_digest: _digest, ...unsigned } = artifact;
  if (computeSemanticArtifactDigest(unsigned as SemanticArtifactUnsigned) !== artifact.artifact_digest) {
    ctx.addIssue({ code: "custom", message: "artifact_digest mismatch" });
  }
});

export type SemanticArtifact = z.infer<typeof SemanticArtifactSchema>;
export type SemanticArtifactSourceBinding = z.infer<typeof SourceBindingSchema>;
export type SemanticArtifactUnsigned = Omit<SemanticArtifact, "artifact_digest">;

export function parseSemanticArtifactSourceBinding(value: unknown): SemanticArtifactSourceBinding {
  return SourceBindingSchema.parse(value);
}

export function computeSemanticArtifactDigest(
  unsigned: SemanticArtifactUnsigned
): string {
  return createHash("sha256").update(JSON.stringify({
    schema_version: unsigned.schema_version,
    kind: unsigned.kind,
    semantic_key: unsigned.semantic_key,
    semantic_contract: unsigned.semantic_contract,
    capability: unsigned.capability,
    capability_set: unsigned.capability_set,
    model_family: unsigned.model_family,
    model_id: unsigned.model_id,
    admission_state: unsigned.admission_state,
    source_bindings: unsigned.source_bindings,
    provider_provenance: unsigned.provider_provenance ?? null,
    replay_identity: unsigned.replay_identity,
    replay_identity_digest: unsigned.replay_identity_digest,
    legacy_conversion_witness: unsigned.legacy_conversion_witness ?? null,
    raw_evidence_binding: unsigned.raw_evidence_binding ?? null,
    raw_response_digest: unsigned.raw_response_digest ?? null,
    deterministic_empty_proof: unsigned.deterministic_empty_proof ?? null,
    quarantine_reason: unsigned.quarantine_reason ?? null
  }), "utf8").digest("hex");
}

export function sealSemanticArtifact(unsigned: SemanticArtifactUnsigned): SemanticArtifact {
  return parseSemanticArtifact({
    ...unsigned,
    artifact_digest: computeSemanticArtifactDigest(unsigned)
  });
}

export function parseSemanticArtifact(value: unknown): SemanticArtifact {
  const parsed = SemanticArtifactSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`semantic artifact is invalid: ${parsed.error.issues[0]?.message ?? "schema"}`);
  }
  return parsed.data;
}

export function isAvailableSemanticArtifact(artifact: SemanticArtifact): boolean {
  return artifact.admission_state === "provider_backed";
}

export function isMintedSemanticAdmissionState(
  state: SemanticArtifact["admission_state"]
): boolean {
  return (MINTED_SEMANTIC_ADMISSION_STATES as readonly string[]).includes(state);
}
