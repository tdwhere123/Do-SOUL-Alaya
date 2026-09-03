import type { AdmissionTask } from "./admit.js";
import { admitDerivedReplayFromRaw } from "./admit.js";
import { assertSemanticArtifactCompatibility } from "./admission-identity.js";
import type { SemanticArtifact } from "./contract.js";
import type { ExtractionCacheWriteLease } from
  "../../fill/manifest/fill-root-guard.js";
import {
  currentSemanticReplayAuthority,
  semanticReplayIdentityDigest,
  unwrapSemanticReplayAuthority,
  type VerifiedSemanticReplayAuthority
} from "./replay-authority.js";
import {
  admitSemanticArtifact,
  findRawBackedDerivedArtifacts,
  inspectSemanticArtifact,
  releaseSemanticArtifactReservation,
  reserveSemanticArtifact,
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
    if (cause instanceof Error && /ROOT_KIND|semantic artifact root/u.test(cause.message)) {
      return current;
    }
    return { status: "invalid", reason: cause instanceof Error ? cause.message : String(cause) };
  }
}

export function materializeDerivedReplayFromRaw(input: {
  readonly root: string;
  readonly task: AdmissionTask;
  readonly lease: ExtractionCacheWriteLease;
  readonly replayAuthority?: VerifiedSemanticReplayAuthority;
}): SemanticArtifact {
  if (input.lease === undefined) {
    throw new Error("derived replay requires an owned write lease");
  }
  input.lease.assertOwned();
  input.lease.assertRoot(input.root);
  const replayAuthority = input.replayAuthority ?? currentSemanticReplayAuthority();
  const currentDigest = semanticReplayIdentityDigest(
    unwrapSemanticReplayAuthority(replayAuthority)
  );
  const sources = findRawBackedDerivedArtifacts(
    input.root, input.task.semanticKey, input.task.capability
  );
  const current = sources.find((artifact) => artifact.replay_identity_digest === currentDigest);
  if (current !== undefined) {
    assertSemanticArtifactCompatibility(input.task, current, false, replayAuthority);
    return current;
  }
  const source = sources.find((artifact) => artifact.admission_state === "provider_backed") ??
    sources[0];
  if (source === undefined) {
    throw new Error("derived replay requires persisted raw");
  }
  const admission = admitDerivedReplayFromRaw({
    root: input.root,
    task: input.task,
    existing: source,
    replayAuthority
  });
  if (admission.kind !== "provider_backed" && admission.kind !== "quarantined") {
    throw new Error(admission.reason);
  }
  const token = reserveSemanticArtifact(
    input.root, input.task.semanticKey, input.task.capability, input.lease
  );
  try {
    input.lease.assertOwned();
    admitSemanticArtifact({
      root: input.root,
      admission: admission.admission,
      reservationToken: token,
      expectedIdentity: input.task
    });
  } catch (cause) {
    try {
      releaseSemanticArtifactReservation(
        input.root, input.task.semanticKey, input.task.capability, token
      );
    } catch (releaseFailure) {
      throw new AggregateError(
        [asError(cause), asError(releaseFailure)],
        "derived rematerialization and reservation release both failed"
      );
    }
    throw cause;
  }
  const materialized = inspectSemanticArtifact(
    input.root, input.task.semanticKey, input.task.capability
  );
  if (materialized.artifact === undefined) {
    throw new Error("derived replay did not admit a readable artifact");
  }
  return materialized.artifact;
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}
