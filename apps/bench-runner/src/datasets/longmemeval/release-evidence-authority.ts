import type { LongMemEvalReleaseEvidenceAuthority } from
  "@do-soul/alaya-eval/authority";
import {
  deriveLongMemEvalReleaseEvidenceAuthority,
  type LongMemEvalAuthoritySelection,
  type VerifiedLongMemEvalDatasetAuthority
} from "./ingestion/fetch.js";

export function deriveLongMemEvalRunnerReleaseEvidenceAuthority(input: {
  readonly datasetAuthority: VerifiedLongMemEvalDatasetAuthority | null;
  readonly offset: number;
  readonly selection: LongMemEvalAuthoritySelection;
}): LongMemEvalReleaseEvidenceAuthority | null {
  if (input.offset > 0) return null;
  return deriveLongMemEvalReleaseEvidenceAuthority(
    input.datasetAuthority,
    input.selection
  );
}
