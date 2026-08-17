import type { ProjectionEraseSubjectKind } from "@do-soul/alaya-protocol";

import type { SelectedSliceKeyV2 } from "../../../flood/slice-key-contract.js";
import {
  applyEraseToL2Bundles,
  type L2MaterializationPolicy,
  type ProjectionL2Bundle
} from "../../../flood/slice-key-l2-bundles.js";
import { digestRecallFieldIdentity } from "../../field-identity.js";
import {
  applyEraseToL1Postings,
  type ProjectionL1Posting
} from "./l1-postings.js";

export type ProjectionGenerationArtifacts = Readonly<{
  readonly generation_id: string;
  readonly postings: readonly ProjectionL1Posting[];
  readonly bundles: readonly ProjectionL2Bundle[];
  readonly slice_keys: readonly SelectedSliceKeyV2[];
  readonly policy: L2MaterializationPolicy;
  readonly artifact_digest: string;
}>;

export function createProjectionGenerationArtifacts(input: Omit<
  ProjectionGenerationArtifacts,
  "artifact_digest"
>): ProjectionGenerationArtifacts {
  return Object.freeze({
    ...input,
    postings: Object.freeze([...input.postings]),
    bundles: Object.freeze([...input.bundles]),
    slice_keys: Object.freeze([...input.slice_keys]),
    policy: Object.freeze({ ...input.policy }),
    artifact_digest: digestProjectionArtifacts(input)
  });
}

export function digestProjectionArtifacts(
  input: Omit<ProjectionGenerationArtifacts, "artifact_digest">
): string {
  return digestRecallFieldIdentity({
    generation_id: input.generation_id,
    postings: input.postings,
    bundles: input.bundles,
    slice_keys: input.slice_keys,
    policy: input.policy
  });
}

export function parseProjectionGenerationArtifacts(
  value: unknown,
  expectedGenerationId: string,
  expectedDigest: string
): ProjectionGenerationArtifacts {
  if (!isRecord(value) || value.generation_id !== expectedGenerationId ||
      !Array.isArray(value.postings) || !Array.isArray(value.bundles) ||
      !Array.isArray(value.slice_keys) || !isRecord(value.policy) ||
      value.artifact_digest !== expectedDigest) {
    throw new Error("persisted projection generation artifacts are invalid");
  }
  const artifacts = value as ProjectionGenerationArtifacts;
  if (digestProjectionArtifacts(artifacts) !== expectedDigest) {
    throw new Error("persisted projection generation artifact digest mismatch");
  }
  return Object.freeze({
    ...artifacts,
    postings: Object.freeze([...artifacts.postings]),
    bundles: Object.freeze([...artifacts.bundles]),
    slice_keys: Object.freeze([...artifacts.slice_keys]),
    policy: Object.freeze({ ...artifacts.policy })
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
