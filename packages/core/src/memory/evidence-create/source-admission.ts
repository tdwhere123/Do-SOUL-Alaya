import {
  SOURCE_SPAN_IDENTITY_OPERATOR_ID,
  SourceRecordIdentitySchema,
  SourceRepresentationSchema,
  sourceProjectionDependenciesAvailable, hostOccurrenceIsMessage,
  fieldReceiptContractFields,
  hashAddressableSourceSpanId,
  hashContentDigest,
  hashSourceRecordId,
  verifyAddressableSourceSpan,
  verifySourceRecordIdentity,
  bindUtteranceAttribution, UNKNOWN_UTTERANCE_ATTRIBUTION, canonicalJson, compareUtcInstants,
  isHostOccurrenceResourceLimit,
  type AddressableSourceSpan,
  type FieldContractSha256,
  type SourceAdmissionPort,
  type SourceAdmissionRequest,
  type SourceRecordIdentity,
  type SourceScopeClass,
  type SourceSpeakerRole
} from "@do-soul/alaya-protocol";
import { captureHostStructure, type HostCaptureBinding } from "./host-occurrence-capture.js";
import { CoreError } from "../../shared/errors.js";
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
  readonly hostCaptureBinding?: HostCaptureBinding;
  readonly audit?: (record: SourceRecordIdentity) => Promise<void>;
}>): SourceAdmissionPort {
  return {
    ...(input.audit === undefined ? {} : { audit: input.audit }),
    findRetained(request, context) {
      if (request.workspace_id !== context.workspaceId || context.workspaceId.length === 0) {
        throw new CoreError("VALIDATION", "source recovery requires workspace-bound caller context");
      }
      const { identity } = sourceIdentity(request, input.sha256);
      const record = input.stores.getRecord(request.workspace_id, identity);
      if (record === null) return null;
      const stored = input.stores.getStoredRecord(request.workspace_id, identity);
      if (stored === null || stored.content_bytes !== request.content_bytes) {
        throw new CoreError("VALIDATION", "source recovery requires the exact available retained body");
      }
      return record;
    },
    hostCaptureResourceLimited(record, context) {
      if (record.workspace_id !== context.workspaceId || input.stores.getStoredRecord(context.workspaceId, record.identity) === null) {
        throw new CoreError("VALIDATION", "capture diagnostic requires a retained source in the caller workspace");
      }
      return input.stores.hasHostCaptureResourceLimit(context.workspaceId, record.identity);
    },
    admit(incoming, context) {
      // Capture once before validation and any composition callback; caller mutation cannot change the write.
      const request = structuredClone(incoming);
      if ((context !== undefined && context.workspaceId !== request.workspace_id) ||
          (request.host_occurrences !== undefined && context === undefined)) {
        throw new CoreError("VALIDATION", "host capture requires workspace-bound caller context");
      }
      const hostBinding = input.hostCaptureBinding ?? context?.hostCapture;
      if (request.spans.some(span => span.purpose === "message")) {
        throw new CoreError("VALIDATION", "message spans must be derived from captured complete occurrences");
      }
      return input.stores.runAtomic(() => {
        input.admitHook?.();
        let persisted: ReturnType<typeof persistRecord>;
        let hostCaptureLimited = false;
        try {
          persisted = persistRecord(request, input.sha256, input.stores, hostBinding);
        } catch (error) {
          if (context?.allowHostCaptureResourceLimit !== true || request.host_occurrences === undefined ||
              !isHostOccurrenceResourceLimit(error)) throw error;
          const { host_occurrences: _refused, ...withoutCapture } = request;
          persisted = persistRecord(withoutCapture, input.sha256, input.stores, hostBinding);
          hostCaptureLimited = true;
        }
        const { record, messageSpans } = persisted;
        const spans = [...request.spans, ...messageSpans].map((span) => persistSpan(
          request, record.identity, assertSpanInContent(request.content_bytes, span), input.sha256, input.stores
        ));
        if (input.stores.getStoredRecord(request.workspace_id, record.identity) === null) {
          throw new CoreError("VALIDATION", "retired source record cannot be admitted");
        }
        if (hostCaptureLimited) input.stores.putHostCaptureResourceLimit(request.workspace_id, record.identity);
        return Object.freeze({ record, spans: Object.freeze(spans),
          ...(hostCaptureLimited ? { host_capture_limited: true as const } : {}) });
      });
    }
  };
}

function persistRecord(
  request: SourceAdmissionRequest,
  sha256: FieldContractSha256,
  stores: FieldFormationStores,
  hostCaptureBinding?: HostCaptureBinding
): Readonly<{ record: SourceRecordIdentity; messageSpans: readonly SourceSpanDraft[] }> {
  const { identity, contentDigest, representation } = sourceIdentity(request, sha256);
  verifyProjectionSources(request, stores);
  const speaker = retainedSourceSpeaker(
    request.speaker === undefined || request.speaker === null ? [] : [request.speaker]
  );
  const scopeClass = retainedSourceScopeClass(request.scope_class);
  const attribution = request.attribution_context === null ? null : bindUtteranceAttribution(
    request.attribution_context === undefined ? UNKNOWN_UTTERANCE_ATTRIBUTION : request.attribution_context,
    request.content_bytes);
  const host = captureHostStructure(request, identity, contentDigest, stores, sha256, hostCaptureBinding);
  const current = stores.getCurrentRecord(request.workspace_id, request.source_id);
  const retained = stores.getStoredRecord(request.workspace_id, identity);
  if (retained === null && current !== null &&
      (canonicalJson(current.host_structure ?? null) !== canonicalJson(host?.descriptor ?? null) ||
        canonicalJson(current.attribution_context ?? null) !== canonicalJson(attribution) ||
        canonicalJson(current.source_representation ?? null) !== canonicalJson(representation ?? null)) &&
      (current.source_version === request.source_version ||
        compareUtcInstants(request.recorded_at, current.recorded_at) !== 1)) {
    throw new CoreError("CONFLICT", "source attribution or representation correction requires a later recorded time and new source revision");
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
    attribution_context: attribution,
    ...(representation === undefined ? {} : { source_representation: representation }),
    ...(host === undefined ? {} : { host_structure: host.descriptor })
  }), sha256);
  if (attribution === null) {
    if (retained === null || (retained.record.attribution_context !== null &&
        retained.record.attribution_context !== undefined) ||
        retained.content_bytes !== request.content_bytes) {
      throw new CoreError("VALIDATION", "null attribution is reserved for an exact retained source record");
    }
  }
  const persisted = stores.putRecord(record, request.content_bytes);
  if (host !== undefined) stores.putHostInventory(request.workspace_id, identity, host.canonical);
  return { record: persisted, messageSpans: host?.inventory.occurrences.flatMap(row =>
    hostOccurrenceIsMessage(row)
      ? [{ start_offset: row.utf8_span[0], end_offset: row.utf8_span[1], purpose: "message" as const }] : []) ?? [] };
}

function sourceIdentity(request: Pick<SourceAdmissionRequest, "source_id" | "source_version" |
  "content_bytes" | "source_representation">, sha256: FieldContractSha256) {
  const contentDigest = hashContentDigest(request.content_bytes, sha256);
  const representation = request.source_representation === undefined ? undefined
    : SourceRepresentationSchema.parse(request.source_representation);
  const identity = hashSourceRecordId({ source_id: request.source_id, source_version: request.source_version,
    content_digest: contentDigest,
    ...(representation === undefined ? {} : { source_representation: representation }) }, sha256);
  return { identity, contentDigest, representation };
}

function verifyProjectionSources(request: SourceAdmissionRequest, stores: FieldFormationStores): void {
  if (request.source_representation?.kind !== "canonical_projection") return;
  const sources = request.source_representation.source_record_ids.map(id => stores.getStoredRecord(request.workspace_id, id));
  if (!sourceProjectionDependenciesAvailable(request, sources.map(source => source === null ? null : ({
    identity: source.record.identity,
    workspace_id: source.record.workspace_id,
    ...(source.record.scope_class === undefined ? {} : { scope_class: source.record.scope_class }),
    current_identity: stores.getCurrentRecord(request.workspace_id, source.record.source_id)?.identity ?? null,
    body_available: true,
    ...(source.record.source_representation === undefined ? {} : { source_representation: source.record.source_representation })
  }))) || sources.some(source => source === null || source.record.source_id === request.source_id)) {
    throw new CoreError("VALIDATION", "projection requires current retained sources in the same workspace and scope");
  }
  const roles = sources.map(source => source!.record.speaker ?? "unknown");
  if ((retainedSourceSpeaker(roles) ?? null) !== (request.speaker ?? null)) {
    throw new CoreError("VALIDATION", "projection speaker differs from its retained excerpts");
  }
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
