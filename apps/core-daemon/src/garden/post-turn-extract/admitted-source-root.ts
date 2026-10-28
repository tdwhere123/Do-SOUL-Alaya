import { AlayaError } from "@do-soul/alaya-protocol";
import type {
  SourceAdmissionPort,
  SourceAdmissionRequest,
  HostOccurrence,
  SourceRecordIdentity,
  SourceRepresentation,
  SourceScopeClass,
  SourceSpeakerRole
} from "@do-soul/alaya-protocol";

export function joinAdmittedTurnExcerpts(
  messages: readonly Readonly<{
    readonly role: string;
    readonly content_excerpt: string;
  }>[]
): string {
  return messages
    .map((message) => `${message.role}: ${message.content_excerpt}`)
    .join("\n");
}

export function admitPostTurnSourceRoot(input: Readonly<{
  readonly admission: SourceAdmissionPort;
  readonly workspaceId: string;
  readonly sourceId: string;
  readonly content: string;
  readonly recordedAt: string;
  readonly eventTime: string | null;
  readonly speaker?: SourceSpeakerRole;
  readonly scope_class?: SourceScopeClass;
  readonly source_representation?: SourceRepresentation;
  readonly host_occurrences?: readonly HostOccurrence[];
}>): Readonly<{ record: SourceRecordIdentity; hostCapture: "captured" | "unknown" | "uncaptured_resource_limit" }> | null {
  if (input.content.length === 0 && input.source_representation?.kind !== "retained_excerpt") {
    return null;
  }
  const request: SourceAdmissionRequest = {
    workspace_id: input.workspaceId,
    source_id: input.sourceId,
    source_version: "1",
    content_bytes: input.content,
    evidence_object_id: null,
    recorded_at: input.recordedAt,
    event_time: input.eventTime,
    valid_from: null,
    valid_to: null,
    ...(input.speaker === undefined ? {} : { speaker: input.speaker }),
    ...(input.scope_class === undefined ? {} : { scope_class: input.scope_class }),
    ...(input.source_representation === undefined ? {} : { source_representation: input.source_representation }),
    spans: input.content.length === 0 ? [] : [
      {
        start_offset: 0,
        end_offset: Buffer.byteLength(input.content, "utf8"),
        purpose: "native_structure"
      }
    ]
  };
  const context = { workspaceId: input.workspaceId };
  if (input.admission.findRetained === undefined) throw new AlayaError("UNAVAILABLE", "post-turn capture requires retained source recovery");
  const retained = input.admission.findRetained(request, context);
  // An automatic retry retains facts, including historical unknown; only an explicit revision can enrich them.
  if (retained !== null) {
    const record = input.admission.admit({ ...request, recorded_at: retained.recorded_at,
      attribution_context: retained.attribution_context ?? null,
      ...(retained.host_structure === undefined ? {} : input.host_occurrences === undefined
        ? { host_structure: retained.host_structure }
        : { host_occurrences: input.host_occurrences }) }, context).record;
    return { record, hostCapture: record.host_structure !== undefined ? "captured" :
      input.admission.hostCaptureResourceLimited?.(record, context) === true ? "uncaptured_resource_limit" : "unknown" };
  }
  const admitted = input.admission.admit({ ...request,
    ...(input.host_occurrences === undefined ? {} : { host_occurrences: input.host_occurrences }) },
  { ...context, allowHostCaptureResourceLimit: true });
  return { record: admitted.record, hostCapture: admitted.host_capture_limited === true
    ? "uncaptured_resource_limit" : admitted.record.host_structure === undefined ? "unknown" : "captured" };
}
