import {
  hashLabeledIdentity,
  type FieldContractSha256,
  type ProjectionEraseSubjectKind
} from "@do-soul/alaya-protocol";

import {
  recallFiniteFieldCapturePostingSeeds,
  type RecallFiniteFieldChannelCapture
} from "../../finite-field-capture.js";
import { compareText } from "../../../../shared/compare-text.js";

export type ProjectionL1PostingSource = "slice_key" | "retrieval_channel";

export type ProjectionL1Posting = Readonly<{
  readonly generation_id: string;
  readonly posting_id: string;
  readonly dimension: string;
  readonly normalized_value: string;
  readonly member_ref: string;
  readonly subject_kind: ProjectionEraseSubjectKind;
  readonly subject_id: string;
  readonly erased: boolean;
  readonly authority: string;
  readonly source: ProjectionL1PostingSource;
  readonly match_id: string | null;
  readonly channel_id: string | null;
}>;

export type ProjectionL1PostingDraft = Omit<ProjectionL1Posting, "posting_id" | "erased">;

export function createProjectionL1Posting(
  draft: ProjectionL1PostingDraft,
  sha256: FieldContractSha256
): ProjectionL1Posting {
  return Object.freeze({
    ...draft,
    erased: false,
    posting_id: hashLabeledIdentity("l1_posting", [
      draft.generation_id,
      draft.dimension,
      draft.normalized_value,
      draft.member_ref,
      draft.source
    ], sha256)
  });
}

export function mergeProjectionL1Postings(
  left: readonly ProjectionL1Posting[],
  right: readonly ProjectionL1Posting[]
): readonly ProjectionL1Posting[] {
  const merged = [...left, ...right];
  assertSingleGeneration(merged);
  const byId = new Map<string, ProjectionL1Posting>();
  for (const posting of merged) {
    byId.set(posting.posting_id, posting);
  }
  return Object.freeze([...byId.values()].sort((leftPosting, rightPosting) =>
    compareText(leftPosting.posting_id, rightPosting.posting_id)
  ));
}

export function materializeRetrievalL1Postings(
  generationId: string,
  captures: readonly Readonly<RecallFiniteFieldChannelCapture>[],
  sha256: FieldContractSha256
): readonly ProjectionL1Posting[] {
  return Object.freeze(captures.flatMap((capture) =>
    recallFiniteFieldCapturePostingSeeds(capture).map((seed) =>
      createProjectionL1Posting({
        generation_id: generationId,
        dimension: "lexical",
        normalized_value: seed.channel_id,
        member_ref: seed.candidate_key,
        subject_kind: "factor",
        subject_id: seed.candidate_key,
        authority: "derived_path",
        source: "retrieval_channel",
        match_id: null,
        channel_id: seed.channel_id
      }, sha256)
    )
  ));
}

export function applyEraseToL1Postings(
  postings: readonly ProjectionL1Posting[],
  subjectId: string,
  subjectKind: ProjectionEraseSubjectKind
): readonly ProjectionL1Posting[] {
  return Object.freeze(postings.map((posting) => {
    if (!matchesEraseSubject(posting, subjectId, subjectKind)) return posting;
    return Object.freeze({
      ...posting,
      erased: true,
      normalized_value: ""
    });
  }));
}

export function assertSingleGeneration(
  postings: readonly Readonly<{ readonly generation_id: string }>[]
): string | null {
  const ids = [...new Set(postings.map((posting) => posting.generation_id))];
  if (ids.length > 1) throw new Error("mixed generation read is forbidden");
  return ids[0] ?? null;
}

function matchesEraseSubject(
  posting: ProjectionL1Posting,
  subjectId: string,
  subjectKind: ProjectionEraseSubjectKind
): boolean {
  if (subjectKind === "generation") return posting.generation_id === subjectId;
  return posting.subject_id === subjectId;
}

