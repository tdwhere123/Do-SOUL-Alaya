import { readErrorMessage, type CandidateMemorySignal } from "@do-soul/alaya-protocol";
import type {
  MaterializationCreatedObject,
  MaterializationRouterDeps,
  PathCandidateMintOutcome,
  SignalRefSeedSpec,
  SignalRefTransientFailureMode
} from "./contracts.js";
import {
  buildFailedSignalRefPathRelationProposal,
  buildFailedSignalRefPathRelationProposalReason,
  buildTimeConcernPathRelationProposal,
  collectMaterializableSignalMemoryRefs,
  hasMaterializableSignalMemoryRefs,
  readTimeConcernPayload
} from "./inputs.js";
import { SIGNAL_REF_SEED_SPECS } from "./signal-ref-seeds.js";

export class MaterializationRouterPathSideEffects {
  public constructor(protected readonly dependencies: MaterializationRouterDeps) {}

  // invariant: optional-side-effect isolation. On a memory-creating branch the
  // memory row + its enrich_pending marker are already durable before this
  // runs, so a time_concern proposal failure must warn-and-continue: a throw
  // here may never flip the branch to success: false (which SignalService would
  // mark terminally FAILED) nor strand the memory without enrichment.
  // see also: packages/core/src/memory/signal-service.ts terminal-FAILED on success!=true
  protected async createTimeConcernProposalBestEffort(
    targetObjectId: string,
    signal: CandidateMemorySignal
  ): Promise<MaterializationCreatedObject | null> {
    try {
      return await this.createTimeConcernPathRelationProposal(targetObjectId, signal);
    } catch (err) {
      console.warn("materialization-router: time_concern proposal failed", {
        targetObjectId,
        signalId: signal.signal_id,
        error: err instanceof Error ? err.message : String(err)
      });
      return null;
    }
  }

  protected async createTimeConcernPathRelationProposal(
    targetObjectId: string,
    signal: CandidateMemorySignal
  ): Promise<MaterializationCreatedObject | null> {
    const port = this.dependencies.pathRelationProposalPort;
    if (port === undefined) {
      return null;
    }
    const timeConcern = readTimeConcernPayload(signal.raw_payload);
    if (timeConcern === null) {
      return null;
    }
    return await port.createPathRelationProposal({
      workspaceId: signal.workspace_id,
      runId: signal.run_id,
      sourceSignalId: signal.signal_id,
      targetObjectId,
      reason: `Create time_concern PathRelation for ${timeConcern.matched_text}.`,
      proposedPathRelation: buildTimeConcernPathRelationProposal(targetObjectId, timeConcern)
    });
  }

  protected async preflightSignalRefFallback(signal: CandidateMemorySignal): Promise<void> {
    if (
      this.dependencies.pathCandidateSinkPort === undefined ||
      !hasMaterializableSignalMemoryRefs(signal)
    ) {
      return;
    }
    if (this.dependencies.enrichPendingPort !== undefined) {
      return;
    }
    const port = this.dependencies.pathRelationProposalPort;
    if (port === undefined) {
      throw new Error(
        "PathRelationProposalPort unavailable before materializing a signal with first-class memory refs"
      );
    }
    await port.assertPathRelationProposalAvailable?.({
      workspaceId: signal.workspace_id,
      runId: signal.run_id,
      sourceSignalId: signal.signal_id
    });
  }

  /**
   * Submits a governed path candidate for every first-class memory ref
   * carried by a memory-creating signal. A permanent "rejected" never blocks
   * materialization of the memory itself. A transient "failed" or thrown sink
   * must either leave a durable proposal record or remain retryable through the
   * enrich_pending marker. This also activates the historically dormant
   * signal-ref edge source — the refs now flow through PathRelationProposalService.
   */
  protected async createAllMemoryRefEdges(
    newObjectId: string,
    signal: CandidateMemorySignal,
    transientFailureMode: SignalRefTransientFailureMode = "durable_proposal"
  ): Promise<readonly MaterializationCreatedObject[]> {
    const createdObjects: MaterializationCreatedObject[] = [];
    for (const spec of SIGNAL_REF_SEED_SPECS) {
      createdObjects.push(
        ...(await this.submitCandidatesFromSignalRefs(
          newObjectId,
          signal,
          spec,
          transientFailureMode
        ))
      );
    }
    return createdObjects;
  }

  // see also: createAllMemoryRefEdges — drives one spec per signal key.
  // First-class *_refs are governed path candidates, not raw_payload
  // conventions.
  protected async submitCandidatesFromSignalRefs(
    newObjectId: string,
    signal: CandidateMemorySignal,
    spec: SignalRefSeedSpec,
    transientFailureMode: SignalRefTransientFailureMode
  ): Promise<readonly MaterializationCreatedObject[]> {
    const createdObjects: MaterializationCreatedObject[] = [];
    const port = this.dependencies.pathCandidateSinkPort;
    if (port === undefined) {
      return createdObjects;
    }

    const refs = signal[spec.signalRefsKey];
    if (refs.length === 0) {
      return createdObjects;
    }

    for (const ref of refs) {
      if (typeof ref !== "string" || ref.trim().length === 0 || ref === newObjectId) {
        continue;
      }

      let outcome: PathCandidateMintOutcome;
      // A thrown sink (port wiring fault, not a decided outcome) folds into the
      // same durable fallback treatment as a returned "failed" — the error
      // text is threaded into the failed proposal so a thrown ref produces
      // exactly ONE durable record when the proposal port is healthy.
      let thrownError: string | null = null;
      try {
        outcome = await port.submitCandidate({
          workspaceId: signal.workspace_id,
          sourceAnchor: { kind: "object", object_id: newObjectId },
          targetAnchor: { kind: "object", object_id: ref },
          relationKind: spec.relationKind,
          initialStrength: spec.initialStrength,
          governanceClass: spec.governanceClass,
          evidenceBasis: spec.evidenceBasis,
          recallBiasSign: spec.recallBiasSign,
          recallBiasMagnitude: spec.recallBiasMagnitude,
          why: [
            `${spec.signalRefsKey} on candidate signal ${signal.signal_id}`,
            `run=${signal.run_id}`
          ],
          runId: signal.run_id
        });
      } catch (err) {
        outcome = "failed";
        thrownError = err instanceof Error ? err.message : String(err);
      }

      // invariant: only "failed" gets the durable fallback treatment. The
      // signal-ref edge is derived by this helper both inline and in the
      // BULK_ENRICH retry lane, so a transient "failed" must either create a
      // durable proposal or throw while the retry marker remains pending.
      // A permanent "rejected" stays
      // a CLEAN, quiet drop — the sink already audited the B3 refusal and retry
      // cannot help. applied / already_present settle silently (the owed path
      // exists). A thrown sink and a returned "failed" both land here and must
      // either persist exactly one durable proposal for the failed ref or throw
      // for the enrich_pending retry lane.
      // see also: packages/core/src/path-graph/path-relation-proposal-service.ts PathMintOutcome.
      // see also: apps/core-daemon/src/garden-runtime.ts runBulkEnrichTask.
      if (outcome === "failed") {
        const failedParams = {
          newObjectId,
          failedRef: ref,
          signal,
          spec,
          thrownError
        };
        if (transientFailureMode === "throw_for_retry") {
          throw new Error(buildFailedSignalRefPathRelationProposalReason(failedParams));
        }
        createdObjects.push(
          await this.createFailedSignalRefPathRelationProposal(failedParams)
        );
      }
    }

    return createdObjects;
  }

  protected async createAllMemoryRefEdgesBestEffort(
    newObjectId: string,
    signal: CandidateMemorySignal,
    retryAvailable: boolean
  ): Promise<readonly MaterializationCreatedObject[]> {
    try {
      return await this.createAllMemoryRefEdges(
        newObjectId,
        signal,
        retryAvailable ? "throw_for_retry" : "durable_proposal"
      );
    } catch (error) {
      if (!retryAvailable || !hasMaterializableSignalMemoryRefs(signal)) {
        throw error;
      }
      console.warn("materialization-router: signal-ref path candidate deferred to enrich_pending retry", {
        sourceMemoryId: newObjectId,
        targetMemoryIds: collectMaterializableSignalMemoryRefs(signal),
        signalId: signal.signal_id,
        runId: signal.run_id,
        error: readErrorMessage(error, "Unknown materialization error")
      });
      return [];
    }
  }

  protected async createFailedSignalRefPathRelationProposal(params: {
    readonly newObjectId: string;
    readonly failedRef: string;
    readonly signal: CandidateMemorySignal;
    readonly spec: SignalRefSeedSpec;
    readonly thrownError: string | null;
  }): Promise<MaterializationCreatedObject> {
    const port = this.dependencies.pathRelationProposalPort;
    if (port === undefined) {
      throw new Error("PathRelationProposalPort unavailable for failed signal-ref path candidate");
    }
    return await port.createPathRelationProposal({
      workspaceId: params.signal.workspace_id,
      runId: params.signal.run_id,
      sourceSignalId: params.signal.signal_id,
      targetObjectId: params.newObjectId,
      reason: buildFailedSignalRefPathRelationProposalReason(params),
      proposedPathRelation: buildFailedSignalRefPathRelationProposal(params)
    });
  }
}
