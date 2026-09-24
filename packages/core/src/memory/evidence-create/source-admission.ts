import {
  SOURCE_SPAN_IDENTITY_OPERATOR_ID,
  SourceRecordIdentitySchema,
  fieldReceiptContractFields,
  hashAddressableSourceSpanId,
  hashContentDigest,
  hashSourceRecordId,
  verifyAddressableSourceSpan,
  verifySourceRecordIdentity,
  bindUtteranceAttribution, UNKNOWN_UTTERANCE_ATTRIBUTION, canonicalJson, compareUtcInstants,
  type AddressableSourceSpan,
  type FieldContractSha256,
  type SourceAdmissionPort,
  type SourceAdmissionRequest,
  type SourceRecordIdentity,
  type SourceScopeClass,
  type SourceSpeakerRole
} from "@do-soul/alaya-protocol";
import type { FieldFormationStores } from "./field-stores.js";
import {
  assertSpanInContent,
  type SourceSpanDraft
} from "./source-span-views.js";

const RECORD_CONSUMER = "projection_generation";
const SPAN_CONSUMER = "factor_incidence";

export function createSourceAdmissionPort(input: Readonly<{
  readonly sha256: FieldContractSha256;
  readonly stores: FieldFormationStores;
  readonly admitHook?: () => void;
}>): SourceAdmissionPort {
  return {
    admit(request) {
      input.admitHook?.();
      const record = persistRecord(request, input.sha256, input.stores);
      const spans = request.spans.map((span) => persistSpan(
        request,
        record.identity,
        assertSpanInContent(request.content_bytes, span),
        input.sha256,
        input.stores
      ));
      return Object.freeze({ record, spans: Object.freeze(spans) });
    }
  };
}

function persistRecord(
  request: SourceAdmissionRequest,
  sha256: FieldContractSha256,
  stores: FieldFormationStores
): SourceRecordIdentity {
  const contentDigest = hashContentDigest(request.content_bytes, sha256);
  const identity = hashSourceRecordId({
    source_id: request.source_id,
    source_version: request.source_version,
    content_digest: contentDigest
  }, sha256);
  const speaker = retainedSourceSpeaker(
    request.speaker === undefined || request.speaker === null ? [] : [request.speaker]
  );
  const scopeClass = retainedSourceScopeClass(request.scope_class);
  const attribution = request.attribution_context === null ? null : bindUtteranceAttribution(
    request.attribution_context === undefined ? UNKNOWN_UTTERANCE_ATTRIBUTION : request.attribution_context,
    request.content_bytes);
  const current = stores.getCurrentRecord(request.workspace_id, request.source_id);
  const retained = stores.getStoredRecord(request.workspace_id, identity);
  if (retained === null && current !== null &&
      canonicalJson(current.attribution_context ?? null) !== canonicalJson(attribution) &&
      (current.source_version === request.source_version ||
        compareUtcInstants(request.recorded_at, current.recorded_at) !== 1)) {
    throw new Error("source attribution correction requires a later recorded time and new source revision");
  }
  const record = verifySourceRecordIdentity(SourceRecordIdentitySchema.parse({
    ...receiptFields(identity),
    schema_version: 1,
    workspace_id: request.workspace_id,
    source_id: request.source_id,
    source_version: request.source_version,
    content_digest: contentDigest,
    evidence_object_id: request.evidence_object_id,
    recorded_at: request.recorded_at,
    event_time: request.event_time,
    valid_from: request.valid_from,
    valid_to: request.valid_to,
    operator_id: SOURCE_SPAN_IDENTITY_OPERATOR_ID,
    ...(speaker === undefined ? {} : { speaker }),
    ...(scopeClass === undefined ? {} : { scope_class: scopeClass }),
    attribution_context: attribution
  }), sha256);
  if (attribution === null) {
    if (retained === null || (retained.record.attribution_context !== null &&
        retained.record.attribution_context !== undefined) ||
        retained.content_bytes !== request.content_bytes) {
      throw new Error("null attribution is reserved for an exact retained source record");
    }
  }
  return stores.putRecord(record, request.content_bytes);
}

export function retainedSourceSpeaker(
  roles: readonly string[]
): SourceSpeakerRole | undefined {
  const speakers = new Set<SourceSpeakerRole>();
  for (const role of roles) {
    if (role === "user" || role === "assistant" || role === "system") speakers.add(role);
    else return undefined;
  }
  return speakers.size === 1 ? [...speakers][0] : undefined;
}

export function retainedSourceScopeClass(
  value: string | null | undefined
): SourceScopeClass | undefined {
  if (value === "project" || value === "global_domain" || value === "global_core") return value;
  return undefined;
}

function persistSpan(
  request: SourceAdmissionRequest,
  recordId: string,
  draft: SourceSpanDraft,
  sha256: FieldContractSha256,
  stores: FieldFormationStores
): AddressableSourceSpan {
  const identity = hashAddressableSourceSpanId({
    record_id: recordId,
    start_offset: draft.start_offset,
    end_offset: draft.end_offset,
    purpose: draft.purpose,
    producer_version: SOURCE_SPAN_IDENTITY_OPERATOR_ID
  }, sha256);
  return stores.putSpan(verifyAddressableSourceSpan({
    ...receiptFields(identity),
    schema_version: 1,
    consumer: SPAN_CONSUMER,
    workspace_id: request.workspace_id,
    record_id: recordId,
    start_offset: draft.start_offset,
    end_offset: draft.end_offset,
    purpose: draft.purpose,
    producer_version: SOURCE_SPAN_IDENTITY_OPERATOR_ID,
    recorded_at: request.recorded_at
  }, sha256));
}

function receiptFields(identity: string) {
  return fieldReceiptContractFields({
    identity,
    producer: SOURCE_SPAN_IDENTITY_OPERATOR_ID,
    consumer: RECORD_CONSUMER
  });
}

export function resolveSourceLineageId(input: Readonly<{
  readonly object_id: string;
  readonly source_hash: string | null;
  readonly artifact_ref: string | null;
}>): string {
  if (input.artifact_ref !== null && input.artifact_ref.length <= 256) {
    return input.artifact_ref;
  }
  if (input.source_hash !== null && input.source_hash.length <= 256) {
    return input.source_hash;
  }
  return input.object_id;
}
