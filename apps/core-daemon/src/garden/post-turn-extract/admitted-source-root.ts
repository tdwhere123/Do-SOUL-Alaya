import type {
  SourceAdmissionPort,
  SourceRecordIdentity,
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
}>): SourceRecordIdentity | null {
  if (input.content.length === 0) {
    return null;
  }
  return input.admission.admit({
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
    spans: [
      {
        start_offset: 0,
        end_offset: Buffer.byteLength(input.content, "utf8"),
        purpose: "native_structure"
      }
    ]
  }).record;
}
