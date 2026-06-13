import {
  type EventLogEntry,
  type Proposal
} from "@do-soul/alaya-protocol";

export interface ProposalServiceEventLogRepoPort {
  append(event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): EventLogEntry | Promise<EventLogEntry>;
  queryByEntity(entityType: string, entityId: string): Promise<readonly EventLogEntry[]>;
}

export interface ProposalServiceProposalRepoPort {
  findById(proposalId: string): Promise<Readonly<Proposal> | null>;
  findByWorkspaceId(workspaceId: string): Promise<readonly Readonly<Proposal>[]>;
  findPending(workspaceId: string): Promise<readonly Readonly<Proposal>[]>;
}

export interface ProposalRuntimeNotifier {
  notifyEntry(entry: EventLogEntry): void | Promise<void>;
}

export interface ProposalServiceDependencies {
  readonly proposalRepo: ProposalServiceProposalRepoPort;
  readonly eventLogRepo: ProposalServiceEventLogRepoPort;
  readonly runtimeNotifier: ProposalRuntimeNotifier;
}

// invariant: Proposal lifecycle reads only. Create / accept / reject of
// memory-governance proposals flow through ResolutionService (typed
// dispatch from soul.resolve verb). Strictly-governed path_relation
// proposals are created by the daemon promote endpoint and applied by
// the daemon's review handler.
// see also: packages/core/src/governance/resolution-service.ts
export class ProposalService {
  public constructor(private readonly dependencies: ProposalServiceDependencies) {}

  public findById(proposalId: string): Promise<Readonly<Proposal> | null> {
    return this.dependencies.proposalRepo.findById(proposalId);
  }

  public findByWorkspaceId(workspaceId: string): Promise<readonly Readonly<Proposal>[]> {
    return this.dependencies.proposalRepo.findByWorkspaceId(workspaceId);
  }

  public findPending(workspaceId: string): Promise<readonly Readonly<Proposal>[]> {
    return this.dependencies.proposalRepo.findPending(workspaceId);
  }
}
