import {
  officialApiSemanticWorksetFromUnits,
  type OfficialApiSemanticWorkUnit
} from "@do-soul/alaya-soul";
import type {
  SemanticArtifact,
  SemanticArtifactSourceBinding
} from "./contract.js";
import {
  currentSemanticReplayAuthority,
  semanticReplayIdentityDigest,
  unwrapSemanticReplayAuthority,
  type VerifiedSemanticReplayAuthority
} from "./replay-authority.js";

export interface SemanticAdmissionIdentity extends OfficialApiSemanticWorkUnit {
  readonly sourceCorpus: string;
  readonly semanticIdentity: NonNullable<OfficialApiSemanticWorkUnit["semanticIdentity"]>;
  readonly capability: string;
  readonly semanticContract: string;
  readonly modelFamily: string;
  readonly modelId: string;
  readonly transportModelId: string;
  readonly requestProfile: string;
  readonly providerUrlSha256: string;
  readonly binding: SemanticArtifactSourceBinding;
}

export function assertSemanticAdmissionIdentity(task: SemanticAdmissionIdentity): void {
  officialApiSemanticWorksetFromUnits([task]);
  if (task.semanticContract !== task.semanticIdentity.contractId) {
    throw new Error("semantic task contract does not match its v2 identity witness");
  }
  if (task.capability.trim().length === 0 || task.modelFamily.trim().length === 0 ||
      task.modelId.trim().length === 0 || task.transportModelId.trim().length === 0 ||
      task.requestProfile.trim().length === 0 ||
      !/^[a-f0-9]{64}$/u.test(task.providerUrlSha256)) {
    throw new Error("semantic task execution compatibility identity is incomplete");
  }
}

export function assertSemanticArtifactCompatibility(
  task: SemanticAdmissionIdentity,
  artifact: SemanticArtifact,
  requireBinding = true,
  replayAuthority: VerifiedSemanticReplayAuthority = currentSemanticReplayAuthority()
): void {
  assertSemanticAdmissionIdentity(task);
  const provenance = artifact.provider_provenance;
  const replayIdentity = unwrapSemanticReplayAuthority(replayAuthority);
  // Endpoint is transport provenance; reuse is assertion+capability+model+replay.
  if (artifact.semantic_key !== task.semanticKey ||
      artifact.semantic_contract !== task.semanticContract ||
      artifact.capability !== task.capability ||
      !artifact.capability_set.includes(task.capability) ||
      artifact.model_family !== task.modelFamily || artifact.model_id !== task.modelId ||
      semanticReplayIdentityDigest(artifact.replay_identity) !==
        semanticReplayIdentityDigest(replayIdentity) ||
      artifact.replay_identity_digest !== semanticReplayIdentityDigest(replayIdentity) ||
      (artifact.admission_state === "provider_backed" && (
        provenance?.model_id !== task.modelId ||
        provenance?.transport_model_id !== task.transportModelId ||
        provenance?.request_profile !== task.requestProfile
      ))) {
    throw new Error("semantic artifact is incompatible with the demanded task");
  }
  if (requireBinding) {
    const binding = artifact.source_bindings.find((candidate) =>
      candidate.occurrenceIdentity === task.binding.occurrenceIdentity);
    if (binding === undefined || JSON.stringify(binding) !== JSON.stringify(task.binding)) {
      throw new Error("semantic artifact does not carry the demanded source binding");
    }
  }
}

export function semanticTaskIdentity(
  task: Pick<SemanticAdmissionIdentity, "semanticKey" | "capability" | "semanticContract" |
    "modelFamily" | "modelId" | "transportModelId" | "requestProfile">
): string {
  return [task.semanticKey, task.capability, task.semanticContract, task.modelFamily,
    task.modelId, task.transportModelId, task.requestProfile].join("\u0000");
}
