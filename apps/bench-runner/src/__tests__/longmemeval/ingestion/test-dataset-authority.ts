import {
  bindLongMemEvalDatasetTestAuthorityToken,
  mintLongMemEvalDatasetAuthorityFromTestToken,
  type VerifiedLongMemEvalDatasetAuthority
} from "../../../datasets/longmemeval/ingestion/fetch.js";
import type { LongMemEvalSelectionAssignment } from "@do-soul/alaya-eval";

const TOKEN = Object.freeze({
  brand: Symbol("longmemeval-dataset-test-authority")
});
bindLongMemEvalDatasetTestAuthorityToken(TOKEN);

export function createTestLongMemEvalDatasetAuthority(input: {
  readonly datasetSha256: string;
  readonly assignments: readonly LongMemEvalSelectionAssignment[];
}): VerifiedLongMemEvalDatasetAuthority {
  return mintLongMemEvalDatasetAuthorityFromTestToken(TOKEN, input);
}
