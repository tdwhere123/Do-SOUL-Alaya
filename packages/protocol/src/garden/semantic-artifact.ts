/** Internal candidate contracts; these do not activate a worker or a public API. */
export interface SemanticExtractionProfile {
  readonly capability: string;
  readonly model: string;
  readonly requestProfile: string;
  readonly promptRevision: string;
  readonly outputSchema: string;
}

export interface SemanticSourceSnapshot {
  readonly workspaceId: string;
  readonly objectId: string;
  readonly revision: string;
  readonly sourceEventRevision: number;
  readonly content: string;
  readonly runId: string;
  readonly createdAt: string;
  readonly trustedRole: "user" | "assistant";
}

export interface SemanticArtifactWork {
  readonly key: string;
  readonly semanticKey: string;
  readonly requestJson: string;
  readonly admissionJson: string;
  readonly bindingJson: string;
}

export interface AdmittedSemanticArtifact {
  readonly key: string;
  readonly rawJson: string;
  readonly payloadJson: string;
  readonly searchText: string;
}

export interface SemanticArtifactCodec {
  plan(source: SemanticSourceSnapshot, profile: SemanticExtractionProfile): readonly SemanticArtifactWork[];
  admit(source: SemanticSourceSnapshot, work: SemanticArtifactWork, rawJson: string): AdmittedSemanticArtifact;
}

export interface SemanticEnrichmentTask {
  readonly id: string;
  readonly workspaceId: string;
  readonly objectId: string;
  readonly revision: string;
  readonly profile: SemanticExtractionProfile;
  readonly status: "pending" | "claimed" | "completed" | "failed";
  readonly claim: string | null;
  readonly claimedAt: string | null;
  readonly attempts: number;
}

export interface SemanticTransportAttempt {
  readonly id: string;
  readonly taskId: string;
  readonly key: string;
  readonly state: "dispatched" | "received" | "uncertain" | "not_sent";
  readonly rawJson: string | null;
  readonly ordinal: number;
  readonly reconciliations: number;
}

export interface ReadySemanticProjection {
  readonly objectId: string;
  readonly sourceRevision: string;
  readonly projectionText: string;
}

export interface SemanticArtifactRepositoryPort {
  source(workspaceId: string, objectId: string): SemanticSourceSnapshot | null;
  isCurrent(task: SemanticEnrichmentTask): boolean;
  task(workspaceId: string, taskId: string): SemanticEnrichmentTask | null;
  claim(task: SemanticEnrichmentTask, token: string, now: string): boolean;
  recover(task: SemanticEnrichmentTask): boolean;
  artifact(workspaceId: string, key: string): AdmittedSemanticArtifact | null;
  attempt(taskId: string, key: string): SemanticTransportAttempt | null;
  acquireWork(task: SemanticEnrichmentTask, key: string, expiredBefore: string): boolean;
  beginReconcile(task: SemanticEnrichmentTask, attemptId: string): void;
  dispatch(task: SemanticEnrichmentTask, key: string, attemptId: string): boolean;
  receive(task: SemanticEnrichmentTask, attemptId: string, rawJson: string): void;
  uncertain(task: SemanticEnrichmentTask, attemptId: string): void;
  reconcile(task: SemanticEnrichmentTask, attemptId: string, rawJson: string | null): void;
  put(task: SemanticEnrichmentTask, artifact: AdmittedSemanticArtifact): void;
  publish(task: SemanticEnrichmentTask, source: SemanticSourceSnapshot,
    work: readonly SemanticArtifactWork[], now: string): number;
  finish(task: SemanticEnrichmentTask, status: "completed" | "failed", reason: string | null, now: string): void;
  searchReady(workspaceId: string, query: string, limit: number): readonly ReadySemanticProjection[];
  searchReadyObserved?(workspaceId: string, query: string, limit: number): {
    readonly rows: readonly ReadySemanticProjection[];
    readonly rowsRead: number;
    readonly candidateRowsRead: number;
    readonly candidateRowsReturned: number;
    readonly nativeVisits: number;
    readonly nativeBytes: number;
    readonly sourceRevisionRowsRead: number;
    readonly projectionRowsRead: number;
    readonly sourceRowsRead: number;
    readonly intentRowsRead: number;
    readonly bytesRead: number;
    readonly truncated: boolean;
    readonly byteAccounting: "utf8_candidate_and_validation_columns";
  };
}
