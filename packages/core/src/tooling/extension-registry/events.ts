import {
  ExtensionDescriptorRegisteredPayloadSchema,
  ExtensionDescriptorRegistrationCompensationFailedPayloadSchema,
  ExtensionDescriptorRegistrationRevertedPayloadSchema,
  RuntimeGovernanceEventType,
  type EventLogEntry,
  type SkillPackage,
  type ToolProvider
} from "@do-soul/alaya-protocol";
import { SYSTEM_ACTOR } from "../../shared/actors.js";
import { deepFreeze } from "../../shared/deep-freeze.js";
import { readNow } from "../../shared/time.js";

export interface DescriptorEventInput {
  readonly descriptor_type: "tool_provider" | "skill_package";
  readonly descriptor_id: string;
  readonly name: string;
  readonly source: ToolProvider["source"] | SkillPackage["source"];
}

type EventEntry = Omit<EventLogEntry, "event_id" | "created_at" | "revision">;

export function createDescriptorRegisteredEventEntry(
  input: DescriptorEventInput,
  systemWorkspaceId: string,
  now?: () => string
): EventEntry {
  const payload = deepFreeze(
    ExtensionDescriptorRegisteredPayloadSchema.parse({
      descriptor_type: input.descriptor_type,
      descriptor_id: input.descriptor_id,
      name: input.name,
      source: input.source,
      registered_at: readNow(now)
    })
  );

  return createEntry(input, systemWorkspaceId, RuntimeGovernanceEventType.EXTENSION_DESCRIPTOR_REGISTERED, payload);
}

export function createDescriptorRegistrationRevertedEventEntry(
  input: Pick<DescriptorEventInput, "descriptor_type" | "descriptor_id">,
  originalEventId: string,
  systemWorkspaceId: string,
  now?: () => string
): EventEntry {
  const payload = deepFreeze(
    ExtensionDescriptorRegistrationRevertedPayloadSchema.parse({
      descriptor_type: input.descriptor_type,
      descriptor_id: input.descriptor_id,
      original_event_id: originalEventId,
      reverted_at: readNow(now)
    })
  );

  return createEntry(input, systemWorkspaceId, RuntimeGovernanceEventType.EXTENSION_DESCRIPTOR_REGISTRATION_REVERTED, payload);
}

export function createDescriptorRegistrationCompensationFailedEventEntry(
  input: Pick<DescriptorEventInput, "descriptor_type" | "descriptor_id">,
  originalEventId: string,
  systemWorkspaceId: string,
  now?: () => string
): EventEntry {
  const payload = deepFreeze(
    ExtensionDescriptorRegistrationCompensationFailedPayloadSchema.parse({
      descriptor_type: input.descriptor_type,
      descriptor_id: input.descriptor_id,
      original_event_id: originalEventId,
      failed_at: readNow(now)
    })
  );

  return createEntry(
    input,
    systemWorkspaceId,
    RuntimeGovernanceEventType.EXTENSION_DESCRIPTOR_REGISTRATION_COMPENSATION_FAILED,
    payload
  );
}

function createEntry(
  input: Pick<DescriptorEventInput, "descriptor_id">,
  systemWorkspaceId: string,
  eventType: EventLogEntry["event_type"],
  payload: EventLogEntry["payload_json"]
): EventEntry {
  return {
    event_type: eventType,
    entity_type: "extension_descriptor",
    entity_id: input.descriptor_id,
    workspace_id: systemWorkspaceId,
    run_id: null,
    caused_by: SYSTEM_ACTOR,
    payload_json: payload
  };
}
