import { randomUUID } from "node:crypto";
import {
  HealthEventKindSchema,
  Phase4AEventType,
  SoulHealthJournalRecordedPayloadSchema,
  type EventLogEntry,
  type HealthJournalEntry,
  type HealthJournalRecordInput,
  type HealthJournalRecordPort
} from "@do-what/protocol";
import { CoreError } from "./errors.js";
import { getNextRevision } from "./shared/event-utils.js";
import { parseNonEmptyString } from "./shared/validators.js";

export interface HealthJournalServiceRepoPort {
  append(input: {
    readonly entry_id: string;
    readonly event_kind: HealthJournalEntry["event_kind"];
    readonly workspace_id: string;
    readonly run_id: string | null;
    readonly summary: string;
    readonly detail_json: Record<string, unknown>;
    readonly created_at: string;
  }): Promise<Readonly<HealthJournalEntry>>;
  findByWorkspace(
    workspaceId: string,
    params?: {
      readonly kind?: HealthJournalEntry["event_kind"];
      readonly limit?: number;
    }
  ): Promise<readonly Readonly<HealthJournalEntry>[]>;
}

export interface HealthJournalServiceEventLogPort {
  append(entry: Omit<EventLogEntry, "event_id" | "created_at">): Promise<EventLogEntry>;
  queryByEntity(entityType: string, entityId: string): Promise<readonly EventLogEntry[]>;
}

export interface HealthJournalServiceSseBroadcasterPort {
  broadcastEntry(entry: EventLogEntry): void | Promise<void>;
}

export interface HealthJournalServiceDependencies {
  readonly repo: HealthJournalServiceRepoPort;
  readonly eventLogRepo: HealthJournalServiceEventLogPort;
  readonly sseBroadcaster?: HealthJournalServiceSseBroadcasterPort;
  readonly generateEntryId?: () => string;
  readonly now?: () => string;
}

const MAX_RECENT_EVENTS_LIMIT = 200;

export class HealthJournalService implements HealthJournalRecordPort {
  private readonly generateEntryId: () => string;
  private readonly now: () => string;

  public constructor(private readonly dependencies: HealthJournalServiceDependencies) {
    this.generateEntryId = dependencies.generateEntryId ?? (() => randomUUID());
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  public async record(entry: HealthJournalRecordInput): Promise<void> {
    const createdAt = ensureIsoDatetime(this.now(), "now");
    const entryId = parseNonEmptyString(this.generateEntryId(), "entry_id");
    const normalizedEntry = normalizeRecordInput(entry);
    const revision = await getNextRevision(this.dependencies.eventLogRepo, "health_journal", entryId);

    const event = await this.dependencies.eventLogRepo.append({
      event_type: Phase4AEventType.SOUL_HEALTH_JOURNAL_RECORDED,
      entity_type: "health_journal",
      entity_id: entryId,
      workspace_id: normalizedEntry.workspace_id,
      run_id: normalizedEntry.run_id,
      caused_by: "system",
      revision,
      payload_json: SoulHealthJournalRecordedPayloadSchema.parse({
        entry_id: entryId,
        event_kind: normalizedEntry.event_kind,
        workspace_id: normalizedEntry.workspace_id,
        occurred_at: createdAt
      })
    });

    await this.dependencies.repo.append({
      entry_id: entryId,
      event_kind: normalizedEntry.event_kind,
      workspace_id: normalizedEntry.workspace_id,
      run_id: normalizedEntry.run_id,
      summary: normalizedEntry.summary,
      detail_json: normalizedEntry.detail_json,
      created_at: createdAt
    });

    await this.dependencies.sseBroadcaster?.broadcastEntry(event);
  }

  public async getRecentEvents(
    workspaceId: string,
    params: {
      readonly kind?: HealthJournalEntry["event_kind"];
      readonly limit?: number;
    } = {}
  ): Promise<readonly Readonly<HealthJournalEntry>[]> {
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspaceId");
    const normalizedKind = params.kind === undefined ? undefined : normalizeEventKind(params.kind);
    const normalizedLimit = normalizeLimit(params.limit);
    const normalizedParams = {
      ...(normalizedKind === undefined ? {} : { kind: normalizedKind }),
      ...(normalizedLimit === undefined ? {} : { limit: normalizedLimit })
    };

    return await this.dependencies.repo.findByWorkspace(parsedWorkspaceId, normalizedParams);
  }
}

function normalizeRecordInput(entry: HealthJournalRecordInput): HealthJournalRecordInput {
  const workspaceId = parseNonEmptyString(entry.workspace_id, "workspace_id");
  const summary = parseNonEmptyString(entry.summary, "summary");
  const runId = normalizeOptionalString(entry.run_id);
  const eventKind = normalizeEventKind(entry.event_kind);
  const detailJson = normalizeDetailJson(entry.detail_json);

  return {
    event_kind: eventKind,
    workspace_id: workspaceId,
    run_id: runId,
    summary,
    detail_json: detailJson
  };
}

function normalizeEventKind(value: string): HealthJournalEntry["event_kind"] {
  try {
    return HealthEventKindSchema.parse(parseNonEmptyString(value, "event_kind"));
  } catch (error) {
    throw new CoreError("VALIDATION", "event_kind must be a supported health event kind", { cause: error });
  }
}

function normalizeLimit(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Number.isInteger(value) || value <= 0) {
    throw new CoreError("VALIDATION", "limit must be a positive integer");
  }

  return Math.min(value, MAX_RECENT_EVENTS_LIMIT);
}

function normalizeOptionalString(value: string | null): string | null {
  if (value === null) {
    return null;
  }

  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
}

function normalizeDetailJson(value: Record<string, unknown>): Record<string, unknown> {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new CoreError("VALIDATION", "detail_json must be an object");
  }

  return { ...value };
}

function ensureIsoDatetime(value: string, fieldName: string): string {
  const epoch = Date.parse(value);

  if (!Number.isFinite(epoch)) {
    throw new CoreError("VALIDATION", `${fieldName} must return a valid ISO timestamp`);
  }

  return new Date(epoch).toISOString();
}
