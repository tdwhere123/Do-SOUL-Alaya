import type {
  AcceptedBy as AcceptedByType,
  EventLogEntry,
  MemoryEntry,
  ProjectMappingAnchor,
  ProjectMappingState as ProjectMappingStateType
} from "@do-soul/alaya-protocol";

export interface ProjectMappingServiceEventLogRepoPort {
  append(entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): EventLogEntry | Promise<EventLogEntry>;
  queryByEntity(entityType: string, entityId: string): Promise<readonly EventLogEntry[]>;
}

export interface ProjectMappingServiceProjectMappingRepoPort {
  create(anchor: ProjectMappingAnchor): Promise<void>;
  findById(id: string): Promise<Readonly<ProjectMappingAnchor> | null>;
  findByIds(ids: readonly string[]): Promise<readonly Readonly<ProjectMappingAnchor>[]>;
  findByWorkspace(
    workspaceId: string,
    state?: ProjectMappingStateType
  ): Promise<readonly Readonly<ProjectMappingAnchor>[]>;
  findByGlobalObjectId(
    globalObjectId: string,
    workspaceId: string
  ): Promise<Readonly<ProjectMappingAnchor> | null>;
  updateState(
    id: string,
    newState: ProjectMappingStateType,
    acceptedBy: AcceptedByType | null,
    at: string
  ): Promise<void>;
  listPending(workspaceId: string): Promise<readonly Readonly<ProjectMappingAnchor>[]>;
}

export interface ProjectMappingServiceMemoryRepoPort {
  findById(id: string): Promise<Readonly<MemoryEntry> | null>;
  findByIds(
    workspaceId: string,
    ids: readonly string[]
  ): Promise<readonly Readonly<MemoryEntry>[]>;
}

export interface ProjectMappingServiceRuntimeNotifierPort {
  notifyEntry(entry: EventLogEntry): void | Promise<void>;
}

export interface ProjectMappingServiceDependencies {
  readonly projectMappingRepo: ProjectMappingServiceProjectMappingRepoPort;
  readonly memoryRepo: ProjectMappingServiceMemoryRepoPort;
  readonly eventLogRepo: ProjectMappingServiceEventLogRepoPort;
  readonly runtimeNotifier?: ProjectMappingServiceRuntimeNotifierPort;
  readonly generateObjectId?: () => string;
  readonly now?: () => string;
}

export class StrictConfirmationRequired extends Error {
  public readonly mappingIds: readonly string[];

  public constructor(mappingIds: readonly string[]) {
    super(`Anchors [${mappingIds.join(", ")}] require strict (per-item) confirmation`);
    this.name = "StrictConfirmationRequired";
    this.mappingIds = Object.freeze([...mappingIds]);
  }
}
