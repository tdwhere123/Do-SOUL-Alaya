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
    artifact_digest: digestProjectionArtifacts(input.postings, input.bundles)
  });
}

export function digestProjectionArtifacts(
  postings: readonly ProjectionL1Posting[],
  bundles: readonly ProjectionL2Bundle[]
): string {
  return digestRecallFieldIdentity({
    postings: postings.map((posting) => posting.posting_id),
    bundles: bundles.map((bundle) => bundle.bundle_id)
  });
}

export function eraseProjectionArtifacts(
  artifacts: ProjectionGenerationArtifacts,
  subjectId: string,
  subjectKind: ProjectionEraseSubjectKind
): ProjectionGenerationArtifacts {
  return createProjectionGenerationArtifacts({
    generation_id: artifacts.generation_id,
    postings: applyEraseToL1Postings(artifacts.postings, subjectId, subjectKind),
    bundles: applyEraseToL2Bundles(artifacts.bundles, subjectId, subjectKind),
    slice_keys: eraseSliceKeySurfaces(artifacts.slice_keys, subjectId, subjectKind),
    policy: artifacts.policy
  });
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
