import type { FieldContractSha256 } from "@do-soul/alaya-protocol";

import {
  createProjectionL1Posting,
  type ProjectionL1Posting
} from "../field/retrieval/projection/l1-postings.js";
import type { SelectedSliceKeyV2 } from "./slice-key-contract.js";

export function materializeSliceKeyL1Postings(
  generationId: string,
  keys: readonly SelectedSliceKeyV2[],
  sha256: FieldContractSha256
): readonly ProjectionL1Posting[] {
  return Object.freeze(keys.flatMap((key) => {
    if (key.authority === "derived_query") return [];
    const memberRef = key.owner_id;
    if (memberRef === null) return [];
    return [createProjectionL1Posting({
      generation_id: generationId,
      dimension: key.dimension,
      normalized_value: key.normalized_value,
      member_ref: memberRef,
      subject_kind: "factor",
      subject_id: memberRef,
      authority: key.authority,
      source: "slice_key",
      match_id: key.match_id,
      channel_id: null
    }, sha256)];
  }));
}
