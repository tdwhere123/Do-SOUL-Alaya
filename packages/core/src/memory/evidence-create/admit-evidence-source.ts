import type { EvidenceCapsule, SourceAdmissionPort, SourceRecordIdentity } from "@do-soul/alaya-protocol";
import type { FieldFormationStores } from "./field-stores.js";
import { resolveSourceLineageId } from "./source-admission.js";
import { deriveAddressableSpanViews } from "./source-span-views.js";

export function admitEvidenceSource(
  evidence: Readonly<EvidenceCapsule>,
  sourceAdmission: SourceAdmissionPort,
  stores: FieldFormationStores
): SourceRecordIdentity {
  const content = evidence.excerpt ?? evidence.gist;
  return stores.runAtomic(() => sourceAdmission.admit({
    workspace_id: evidence.workspace_id,
    source_id: resolveSourceLineageId({
      object_id: evidence.object_id,
      source_hash: evidence.source_hash,
      artifact_ref: evidence.physical_anchor?.artifact_ref ?? null
    }),
    source_version: "1",
    content_bytes: content,
    evidence_object_id: evidence.object_id,
    recorded_at: evidence.created_at,
    event_time: evidence.event_anchor?.occurred_at ?? null,
    valid_from: null,
    valid_to: null,
    spans: deriveAddressableSpanViews(content)
  }).record);
}
