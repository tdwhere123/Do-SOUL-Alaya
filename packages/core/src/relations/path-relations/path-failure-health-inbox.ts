// invariant: D-EDGEAUDIT operator-triage port. A governed path-relation
// creation/mint failure is EventLog-audited at its source
// (PATH_RELATION_REJECTED on the mint side, SOUL_GRAPH_EDGE_PROPOSAL_PATH_MINT_FAILED
// on the accept-owed side) but is otherwise invisible to the Inspector health
// inbox. This port lets both failure sites surface a `path_relation_failure`
// health_inbox group WITHOUT coupling core to the storage repo: the daemon
// implements it once against SqliteHealthIssueGroupRepo (find-existing +
// count-increment upsert keyed on workspace_id/target_object_id/cause_kind).
// The write is best-effort projection — a failure here must never break the
// underlying path/accept flow, so callers swallow its throw.
// see also: edge-proposal-service.ts handleMintFailure;
//   path-relation-proposal-service.ts emitRejection;
//   protocol HealthIssueCauseKind.PATH_RELATION_FAILURE.
export interface PathFailureHealthInboxEntry {
  readonly workspaceId: string;
  // The source memory/workspace whose durable topology failed to form. On the
  // mint-reject side there is no path row, so this is the source anchor's
  // backing object id; on the accept-owed side it is the proposal's source
  // memory id.
  readonly targetObjectId: string;
  readonly observedAt: string;
}

export interface PathFailureHealthInboxPort {
  recordPathRelationFailure(entry: PathFailureHealthInboxEntry): Promise<void> | void;
}
