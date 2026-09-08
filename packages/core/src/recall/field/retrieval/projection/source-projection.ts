import { CONDITIONAL_SOURCE_FRONTIER_OPERATOR_ID, hashContentDigest } from "@do-soul/alaya-protocol";
import type { FieldFormationStores } from "../../../../memory/evidence-create/field-stores.js";
import { fieldContractSha256 } from "../../../../shared/field-hash.js";
import { digestRecallFieldIdentity } from "../../field-identity.js";
import { compareText } from "../../../../shared/compare-text.js";

export function projectSourceFormationSnapshot(input: Readonly<{
  readonly workspaceId: string;
  readonly stores: FieldFormationStores;
}>): Readonly<{ readonly input_event_frontier: string }> {
  const records = input.stores.listStoredRecords(input.workspaceId).map(({ record, content_bytes }) => {
    if (hashContentDigest(content_bytes, fieldContractSha256) !== record.content_digest) {
      throw new Error("stored source body does not match its immutable digest");
    }
    return record;
  });
  const bindings = [...input.stores.listRecordEvidenceBindings(input.workspaceId)].sort(
    (left, right) => compareText(
      JSON.stringify([left.record_id, left.evidence_object_id]),
      JSON.stringify([right.record_id, right.evidence_object_id])
    )
  );
  return Object.freeze({
    input_event_frontier: digestRecallFieldIdentity({
      format: CONDITIONAL_SOURCE_FRONTIER_OPERATOR_ID,
      records: sortByIdentity(records),
      bindings,
      spans: sortByIdentity(input.stores.listSpans(input.workspaceId)),
      factors: sortByIdentity(input.stores.listFactors(input.workspaceId)),
      incidences: sortByIdentity(input.stores.listIncidences(input.workspaceId))
    })
  });
}

function sortByIdentity<T extends Readonly<{ identity: string }>>(rows: readonly T[]): readonly T[] {
  return [...rows].sort((left, right) => compareText(left.identity, right.identity));
}
