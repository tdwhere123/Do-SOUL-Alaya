import type { ProjectionEraseSubjectKind } from "@do-soul/alaya-protocol";

import type { SelectedSliceKeyV2 } from "../../../flood/slice-key-contract.js";
import { applyEraseToL2Bundles } from "../../../flood/slice-key-l2-bundles.js";
import { digestRecallFieldIdentity } from "../../field-identity.js";
import {
  internProjectionGenerationArtifacts,
  INTERNED_SOURCE_STATE_ARTIFACTS_FORMAT,
  rehydrateProjectionGenerationArtifacts,
  type InternedProjectionGenerationArtifacts,
  type RehydratedProjectionGenerationArtifacts
} from "./generation-artifact-intern.js";
import { applyEraseToL1Postings } from "./l1-postings.js";

export type ProjectionGenerationArtifacts = RehydratedProjectionGenerationArtifacts & Readonly<{
  readonly artifact_digest: string;
}>;

export {
  internProjectionGenerationArtifacts,
  rehydrateProjectionGenerationArtifacts,
  INTERNED_SOURCE_STATE_ARTIFACTS_FORMAT,
  type InternedProjectionGenerationArtifacts,
  type InternedProjectionSliceKey,
  type RehydratedProjectionGenerationArtifacts
} from "./generation-artifact-intern.js";

export function createProjectionGenerationArtifacts(input: Omit<
  ProjectionGenerationArtifacts,
  "artifact_digest"
>): ProjectionGenerationArtifacts {
  const interned = internProjectionGenerationArtifacts(input);
  return freezeConsumerArtifacts(
    rehydrateProjectionGenerationArtifacts(interned),
    digestRecallFieldIdentity(interned)
  );
}

export function digestProjectionArtifacts(
  input: Omit<ProjectionGenerationArtifacts, "artifact_digest"> | InternedProjectionGenerationArtifacts
): string {
  return digestRecallFieldIdentity(internProjectionGenerationArtifacts(input));
}

export function parseProjectionGenerationArtifacts(
  value: unknown,
  expectedGenerationId: string,
  expectedDigest: string
): ProjectionGenerationArtifacts {
  if (!isParseableArtifacts(value, expectedGenerationId)) {
    throw new Error("persisted projection generation artifacts are invalid");
  }
  const interned = internProjectionGenerationArtifacts(value);
  const internedDigest = digestRecallFieldIdentity(interned);
  // Pre-intern rows digest the expanded graph; accept that digest and
  // return interned-canonical consumer artifacts rather than fail closed.
  if (
    internedDigest !== expectedDigest &&
    !legacyExpandedDigestMatches(value, expectedDigest)
  ) {
    throw new Error("persisted projection generation artifact digest mismatch");
  }
  return freezeConsumerArtifacts(
    rehydrateProjectionGenerationArtifacts(interned),
    internedDigest
  );
}

function isParseableArtifacts(value: unknown, expectedGenerationId: string): boolean {
  if (
    !isRecord(value) ||
    value.generation_id !== expectedGenerationId ||
    !Array.isArray(value.postings) ||
    !Array.isArray(value.bundles) ||
    !Array.isArray(value.slice_keys) ||
    !isRecord(value.policy)
  ) {
    return false;
  }
  if (value.artifacts_format === INTERNED_SOURCE_STATE_ARTIFACTS_FORMAT) {
    return isRecord(value.source_states);
  }
  return value.artifacts_format === undefined;
}

function legacyExpandedDigestMatches(value: unknown, expectedDigest: string): boolean {
  if (!isRecord(value) || value.artifacts_format !== undefined) return false;
  return digestRecallFieldIdentity({
    generation_id: value.generation_id,
    postings: value.postings,
    bundles: value.bundles,
    slice_keys: value.slice_keys,
    policy: value.policy
  }) === expectedDigest;
}

function freezeConsumerArtifacts(
  rehydrated: RehydratedProjectionGenerationArtifacts,
  artifactDigest: string
): ProjectionGenerationArtifacts {
  return Object.freeze({
    generation_id: rehydrated.generation_id,
    postings: Object.freeze([...rehydrated.postings]),
    bundles: Object.freeze([...rehydrated.bundles]),
    slice_keys: Object.freeze([...rehydrated.slice_keys]),
    policy: Object.freeze({ ...rehydrated.policy }),
    artifact_digest: artifactDigest
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function eraseProjectionArtifacts(
  artifacts: ProjectionGenerationArtifacts,
  subjectId: string,
  subjectKind: ProjectionEraseSubjectKind
): ProjectionGenerationArtifacts {
  const surfaces = erasedSurfaces(artifacts, subjectId, subjectKind);
  return createProjectionGenerationArtifacts({
    generation_id: artifacts.generation_id,
    postings: applyEraseToL1Postings(artifacts.postings, subjectId, subjectKind),
    bundles: applyEraseToL2Bundles(
      artifacts.bundles, subjectId, subjectKind, surfaces
    ),
    slice_keys: eraseSliceKeySurfaces(artifacts.slice_keys, subjectId, subjectKind),
    policy: artifacts.policy
  });
}

function erasedSurfaces(
  artifacts: ProjectionGenerationArtifacts,
  subjectId: string,
  subjectKind: ProjectionEraseSubjectKind
): readonly string[] {
  if (subjectKind === "generation") return Object.freeze([]);
  const fromPostings = artifacts.postings
    .filter((posting) => posting.subject_id === subjectId)
    .map((posting) => posting.normalized_value);
  const fromKeys = artifacts.slice_keys
    .filter((key) => key.owner_id === subjectId)
    .map((key) => key.normalized_value);
  return Object.freeze([...new Set([...fromPostings, ...fromKeys])]);
}

function eraseSliceKeySurfaces(
  keys: readonly SelectedSliceKeyV2[],
  subjectId: string,
  subjectKind: ProjectionEraseSubjectKind
): readonly SelectedSliceKeyV2[] {
  return Object.freeze(keys.flatMap((key) => {
    if (subjectKind === "generation" || key.owner_id === subjectId) return [];
    if (key.normalized_value !== subjectId) return [key];
    return [Object.freeze({ ...key, normalized_value: "" })];
  }));
}
