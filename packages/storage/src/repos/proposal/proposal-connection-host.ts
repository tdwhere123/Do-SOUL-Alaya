import type { StorageDatabase } from "../../sqlite/db.js";
import { RefreshableStatementHolder } from "../../sqlite/refreshable-statement-holder.js";
import { getEventLogWriter, insertEventLogEntry } from "../shared/event-log-writer.js";
import { prepareProposalStatements, type ProposalStatements } from "./sqlite-proposal-statements.js";

export class ProposalConnectionHost implements ProposalStatements {
  private readonly statementHolder: RefreshableStatementHolder<ProposalStatements>;
  private eventLogWriterCache: Parameters<typeof insertEventLogEntry>[0] | null = null;
  private eventLogWriterConnectionVersion = -1;

  public constructor(private readonly db: StorageDatabase) {
    this.statementHolder = new RefreshableStatementHolder(db, prepareProposalStatements);
  }

  public get createStatement() {
    return this.activeStatements().createStatement;
  }

  public get findPendingByDedupeKeyStatement() {
    return this.activeStatements().findPendingByDedupeKeyStatement;
  }

  public get assignReviewerStatement() {
    return this.activeStatements().assignReviewerStatement;
  }

  public get findByIdStatement() {
    return this.activeStatements().findByIdStatement;
  }

  public get findByWorkspaceIdStatement() {
    return this.activeStatements().findByWorkspaceIdStatement;
  }

  public get findByWorkspaceIdPagedStatement() {
    return this.activeStatements().findByWorkspaceIdPagedStatement;
  }

  public get countByWorkspaceIdStatement() {
    return this.activeStatements().countByWorkspaceIdStatement;
  }

  public get findPendingStatement() {
    return this.activeStatements().findPendingStatement;
  }

  public get findPendingPagedStatement() {
    return this.activeStatements().findPendingPagedStatement;
  }

  public get countPendingStatement() {
    return this.activeStatements().countPendingStatement;
  }

  public get findPendingByRunIdStatement() {
    return this.activeStatements().findPendingByRunIdStatement;
  }

  public get findReviewerAssignmentStatement() {
    return this.activeStatements().findReviewerAssignmentStatement;
  }

  public get updateResolutionStatement() {
    return this.activeStatements().updateResolutionStatement;
  }

  public get updateResolutionWithIdentityStatement() {
    return this.activeStatements().updateResolutionWithIdentityStatement;
  }

  public get updatePendingResolutionStatement() {
    return this.activeStatements().updatePendingResolutionStatement;
  }

  public get updatePendingResolutionWithIdentityStatement() {
    return this.activeStatements().updatePendingResolutionWithIdentityStatement;
  }

  public get findMemoryEntryByIdStatement() {
    return this.activeStatements().findMemoryEntryByIdStatement;
  }

  public get updateMemoryEntryStatement() {
    return this.activeStatements().updateMemoryEntryStatement;
  }

  public get deleteEvidenceRefsByMemoryStatement() {
    return this.activeStatements().deleteEvidenceRefsByMemoryStatement;
  }

  public get insertEvidenceRefStatement() {
    return this.activeStatements().insertEvidenceRefStatement;
  }

  public get findRevokableGreenStatusStatement() {
    return this.activeStatements().findRevokableGreenStatusStatement;
  }

  public get revokeGreenStatusStatement() {
    return this.activeStatements().revokeGreenStatusStatement;
  }

  public get findPathRelationByAnchorMemoryIdStatement() {
    return this.activeStatements().findPathRelationByAnchorMemoryIdStatement;
  }

  public get createPathRelationStatement() {
    return this.activeStatements().createPathRelationStatement;
  }

  public get updatePathRelationLegitimacyStatement() {
    return this.activeStatements().updatePathRelationLegitimacyStatement;
  }

  public get createSynthesisCapsuleStatement() {
    return this.activeStatements().createSynthesisCapsuleStatement;
  }

  public get eventLogWriter(): Parameters<typeof insertEventLogEntry>[0] {
    return this.activeEventLogWriter();
  }

  public transaction<T>(fn: () => T, options: { readonly immediate?: boolean } = {}): T {
    const txn = this.activeConnection().transaction(fn);
    return options.immediate === true ? txn.immediate() : txn();
  }

  private activeStatements(): ProposalStatements {
    return this.statementHolder.active();
  }

  private activeConnection(): StorageDatabase["connection"] {
    this.activeStatements();
    return this.db.connection;
  }

  private activeEventLogWriter(): Parameters<typeof insertEventLogEntry>[0] {
    this.activeConnection();
    const connectionVersion = this.db.getConnectionVersion();
    if (
      this.eventLogWriterCache === null ||
      this.eventLogWriterConnectionVersion !== connectionVersion
    ) {
      this.eventLogWriterCache = getEventLogWriter(this.db.connection);
      this.eventLogWriterConnectionVersion = connectionVersion;
    }
    return this.eventLogWriterCache;
  }
}
