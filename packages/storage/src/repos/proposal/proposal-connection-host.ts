import type { StorageDatabase } from "../../sqlite/db.js";
import { RefreshableStatementHolder } from "../../sqlite/refreshable-statement-holder.js";
import { getEventLogWriter } from "../runtime/writes/event-log-writer.js";
import { runSynchronousEventLogTransaction } from "../runtime/event-log/writes/synchronous-transaction.js";
import { prepareProposalStatements, type ProposalStatements } from "./statements/sqlite-proposal-statements.js";
import type { SqliteStatement } from "./statements/proposal-statement-groups.js";

export class ProposalConnectionHost implements ProposalStatements {
  private readonly statementHolder: RefreshableStatementHolder<ProposalStatements>;

  public constructor(private readonly db: StorageDatabase) {
    this.statementHolder = new RefreshableStatementHolder(db, prepareProposalStatements);
  }

  public get createStatement(): SqliteStatement {
    return this.activeStatements().createStatement;
  }

  public get findPendingByDedupeKeyStatement(): SqliteStatement {
    return this.activeStatements().findPendingByDedupeKeyStatement;
  }

  public get assignReviewerStatement(): SqliteStatement {
    return this.activeStatements().assignReviewerStatement;
  }

  public get findByIdStatement(): SqliteStatement {
    return this.activeStatements().findByIdStatement;
  }

  public get findByWorkspaceIdStatement(): SqliteStatement {
    return this.activeStatements().findByWorkspaceIdStatement;
  }

  public get findByWorkspaceIdPagedStatement(): SqliteStatement {
    return this.activeStatements().findByWorkspaceIdPagedStatement;
  }

  public get countByWorkspaceIdStatement(): SqliteStatement {
    return this.activeStatements().countByWorkspaceIdStatement;
  }

  public get findPendingStatement(): SqliteStatement {
    return this.activeStatements().findPendingStatement;
  }

  public get findPendingPagedStatement(): SqliteStatement {
    return this.activeStatements().findPendingPagedStatement;
  }

  public get countPendingStatement(): SqliteStatement {
    return this.activeStatements().countPendingStatement;
  }

  public get findPendingByRunIdStatement(): SqliteStatement {
    return this.activeStatements().findPendingByRunIdStatement;
  }

  public get findReviewerAssignmentStatement(): SqliteStatement {
    return this.activeStatements().findReviewerAssignmentStatement;
  }



  public get updatePendingResolutionStatement(): SqliteStatement {
    return this.activeStatements().updatePendingResolutionStatement;
  }

  public get updatePendingResolutionWithIdentityStatement(): SqliteStatement {
    return this.activeStatements().updatePendingResolutionWithIdentityStatement;
  }

  public get findMemoryEntryByIdStatement(): SqliteStatement {
    return this.activeStatements().findMemoryEntryByIdStatement;
  }

  public get updateMemoryEntryStatement(): SqliteStatement {
    return this.activeStatements().updateMemoryEntryStatement;
  }

  public get deleteEvidenceRefsByMemoryStatement() {
    return this.activeStatements().deleteEvidenceRefsByMemoryStatement;
  }

  public get insertEvidenceRefStatement() {
    return this.activeStatements().insertEvidenceRefStatement;
  }

  public get findRevokableGreenStatusStatement(): SqliteStatement {
    return this.activeStatements().findRevokableGreenStatusStatement;
  }

  public get revokeGreenStatusStatement(): SqliteStatement {
    return this.activeStatements().revokeGreenStatusStatement;
  }

  public get findPathRelationByAnchorMemoryIdStatement(): SqliteStatement {
    return this.activeStatements().findPathRelationByAnchorMemoryIdStatement;
  }

  public get createPathRelationStatement(): SqliteStatement {
    return this.activeStatements().createPathRelationStatement;
  }

  public get updatePathRelationLegitimacyStatement(): SqliteStatement {
    return this.activeStatements().updatePathRelationLegitimacyStatement;
  }

  public get createSynthesisCapsuleStatement(): SqliteStatement {
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
