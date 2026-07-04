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
  findByWorkspaceId(
    workspaceId: string,
    page?: ProposalListPageOptions
  ): Promise<readonly Readonly<Proposal>[]>;
  countByWorkspaceId?(workspaceId: string): Promise<number>;
  findPending(
    workspaceId: string,
    page?: ProposalListPageOptions
  ): Promise<readonly Readonly<Proposal>[]>;
  countPending?(workspaceId: string): Promise<number>;
}

export interface ProposalListPageOptions {
  readonly limit: number;
  readonly offset: number;
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

  public findByWorkspaceId(
    workspaceId: string,
    page?: ProposalListPageOptions
  ): Promise<readonly Readonly<Proposal>[]> {
    if (page === undefined) {
      return this.dependencies.proposalRepo.findByWorkspaceId(workspaceId);
    }
    return this.dependencies.proposalRepo.findByWorkspaceId(workspaceId, page);
  }

  public async countByWorkspaceId(workspaceId: string): Promise<number> {
    const countByWorkspaceId = this.dependencies.proposalRepo.countByWorkspaceId;
    if (countByWorkspaceId !== undefined) {
      return await countByWorkspaceId.call(this.dependencies.proposalRepo, workspaceId);
    }
    return (await this.dependencies.proposalRepo.findByWorkspaceId(workspaceId)).length;
  }

  public findPending(
    workspaceId: string,
    page?: ProposalListPageOptions
  ): Promise<readonly Readonly<Proposal>[]> {
    if (page === undefined) {
      return this.dependencies.proposalRepo.findPending(workspaceId);
    }
    return this.dependencies.proposalRepo.findPending(workspaceId, page);
  }

  public async countPending(workspaceId: string): Promise<number> {
    const countPending = this.dependencies.proposalRepo.countPending;
    if (countPending !== undefined) {
      return await countPending.call(this.dependencies.proposalRepo, workspaceId);
    }
    return (await this.dependencies.proposalRepo.findPending(workspaceId)).length;
  }
}
