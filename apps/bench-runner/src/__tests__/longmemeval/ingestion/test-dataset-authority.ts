import {
  createTestLongMemEvalDatasetAuthority as mintWithToken,
  LONGMEMEVAL_DATASET_TEST_AUTHORITY_KIND,
  type LongMemEvalDatasetTestAuthorityToken,
  type VerifiedLongMemEvalDatasetAuthority
} from "../../../datasets/longmemeval/ingestion/fetch.js";
import type { LongMemEvalSelectionAssignment } from "@do-soul/alaya-eval";

const TOKEN: LongMemEvalDatasetTestAuthorityToken = Object.freeze({
  kind: LONGMEMEVAL_DATASET_TEST_AUTHORITY_KIND
});

export function createTestLongMemEvalDatasetAuthority(input: {
  readonly datasetSha256: string;
  readonly assignments: readonly LongMemEvalSelectionAssignment[];
}): VerifiedLongMemEvalDatasetAuthority {
  return mintWithToken(TOKEN, input);
}

export function longMemEvalDatasetTestAuthorityToken(): LongMemEvalDatasetTestAuthorityToken {
  return TOKEN;
}
