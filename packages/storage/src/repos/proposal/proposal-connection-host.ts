import type { StorageDatabase } from "../../sqlite/db.js";
import { RefreshableStatementHolder } from "../../sqlite/refreshable-statement-holder.js";
import { getEventLogWriter } from "../runtime/writes/event-log-writer.js";
import { runSynchronousEventLogTransaction } from "../runtime/event-log/writes/synchronous-transaction.js";
import { prepareProposalStatements, type ProposalStatements } from "./statements/sqlite-proposal-statements.js";

export class ProposalConnectionHost implements ProposalStatements {
  private readonly statementHolder: RefreshableStatementHolder<ProposalStatements>;

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

  public get eventLogWriter(): ReturnType<typeof getEventLogWriter> {
    return getEventLogWriter(this.activeConnection());
  }

  public transaction<T>(fn: () => T): T {
    return runSynchronousEventLogTransaction(this.activeConnection(), fn);
  }

  private activeStatements(): ProposalStatements {
    return this.statementHolder.active();
  }

  private activeConnection(): StorageDatabase["connection"] {
    this.activeStatements();
    return this.db.connection;
  }

}
