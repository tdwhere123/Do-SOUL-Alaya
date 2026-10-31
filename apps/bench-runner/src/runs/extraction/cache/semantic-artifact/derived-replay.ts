import type { AdmissionTask } from "./admit.js";
import { assertSemanticArtifactCompatibility } from "./admission-identity.js";
import {
  currentSemanticReplayAuthority,
  semanticReplayIdentityDigest,
  unwrapSemanticReplayAuthority
} from "./replay-authority.js";
import {
  findRawBackedDerivedArtifacts,
  inspectSemanticArtifact,
  type SemanticArtifactInspectResult
} from "./store.js";

export function inspectCurrentOrReplayDerived(
  root: string,
  task: AdmissionTask
): SemanticArtifactInspectResult {
  const current = inspectSemanticArtifact(root, task.semanticKey, task.capability);
  if (current.status !== "missing") return current;
  try {
    const replayAuthority = currentSemanticReplayAuthority();
    const currentDigest = semanticReplayIdentityDigest(
      unwrapSemanticReplayAuthority(replayAuthority)
    );
    const matching = findRawBackedDerivedArtifacts(
      root, task.semanticKey, task.capability
    ).find((artifact) => artifact.replay_identity_digest === currentDigest);
    if (matching === undefined) return current;
    assertSemanticArtifactCompatibility(task, matching, false, replayAuthority);
    return { status: matching.admission_state, artifact: matching };
  } catch (cause) {
    if (isAbsentPath(cause)) return current;
    return { status: "invalid", reason: cause instanceof Error ? cause.message : String(cause) };
  }
}

function isAbsentPath(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause &&
    (cause as { readonly code?: unknown }).code === "ENOENT";
}
