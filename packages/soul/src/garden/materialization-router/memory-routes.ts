import { readErrorMessage, type CandidateMemorySignal } from "@do-soul/alaya-protocol";
import type {
  MaterializationCreatedObject,
  MaterializationResult,
  MaterializationTarget,
  MemoryMaterializationCreatedObject,
  MemoryMaterializationInput,
  ReconciliationPort
} from "./contracts.js";
import {
  buildClaimInput,
  buildDistilledFact,
  buildEnrichmentIntent,
  buildEvidenceInput,
  buildFacetTagsProjection,
  buildMemoryInput
} from "./inputs.js";
import { MaterializationRouterPathSideEffects } from "./path-side-effects.js";

type MemoryEntryMaterialization = {
  readonly evidence: MaterializationCreatedObject;
  readonly memory: MemoryMaterializationCreatedObject;
  readonly createdObjects: MaterializationCreatedObject[];
};

interface ReconciledMaterializationState {
  readonly createdObjects: MaterializationCreatedObject[];
  evidenceId?: string;
  appendedMemory?: MemoryMaterializationCreatedObject;
}

class MaterializationPartialFailureError extends Error {
  public constructor(
    message: string,
    public readonly createdObjects: readonly MaterializationCreatedObject[],
    options?: { readonly cause?: unknown }
  ) {
    super(message, options);
    this.name = "MaterializationPartialFailureError";
  }
}

export class MaterializationRouterMemoryRoutes extends MaterializationRouterPathSideEffects {
  // invariant: ingest reconciliation covers the materializeMemoryEntryOnly
  // path only (the bench `fact` object_kind). materialize_and_claim is
  // intentionally NOT reconciled — a claim-bearing signal
  // carries governance structure whose dedup is the conflict / claim
  // surface's job, not the lexical ingest gate.
  protected async materializeMemoryAndClaim(
    signal: CandidateMemorySignal,
    target: MaterializationTarget
  ): Promise<MaterializationResult> {
    const createdObjects: Array<{ object_kind: string; object_id: string }> = [];

    try {
      await this.preflightSignalRefFallback(signal);

      const materializedMemory = await this.createEvidenceBackedMemoryEntry(signal);
      createdObjects.push(...materializedMemory.createdObjects);

      const claim = await this.dependencies.claimService.create(
        buildClaimInput(signal, [materializedMemory.evidence.object_id], [materializedMemory.memory.object_id])
      );
      createdObjects.push({ object_kind: claim.object_kind, object_id: claim.object_id });

      return {
        signal_id: signal.signal_id,
        target_kind: target.kind,
        route_target: target.route_target,
        routing_reason: target.routing_reason,
        created_objects: createdObjects,
        success: true
      };
    } catch (error) {
      createdObjects.push(...readPartialFailureCreatedObjects(error));
      return {
        signal_id: signal.signal_id,
        target_kind: target.kind,
        route_target: target.route_target,
        routing_reason: target.routing_reason,
        created_objects: createdObjects,
        success: false,
        error: readErrorMessage(error, "Unknown materialization error")
      };
    }
  }

  // invariant: produces evidence + memory but no claim. Used when the
  // signal records an outcome / reference / task_state — facts worth
  // remembering but not governance-mutating (a claim would over-promote
  // the signal into a draft awaiting review).
  // see also: materializeMemoryAndClaim — adds the claim_form layer.
  // When a reconciliationPort is wired the incoming distilled fact is
  // reconciled against the existing lexical pool: a near-exact lexical
  // duplicate is dropped (NOOP), an LLM-judged refinement updates an
  // existing row in place (UPDATE), and only a distinct fact is appended
  // (ADD). Without the port every fact is appended — the unchanged
  // default behavior.
  protected async materializeMemoryEntryOnly(
    signal: CandidateMemorySignal,
    target: MaterializationTarget
  ): Promise<MaterializationResult> {
    if (this.dependencies.reconciliationPort !== undefined) {
      return await this.materializeReconciledMemoryEntry(
        signal,
        target,
        this.dependencies.reconciliationPort
      );
    }
    return await this.materializeMemoryEntryAppend(signal, target);
  }

  // invariant: the unchanged default ingest path — every fact is
  // appended (evidence_capsule + memory_entry), no reconciliation. Also
  // the fallback when reconciliation throws.
  protected async materializeMemoryEntryAppend(
    signal: CandidateMemorySignal,
    target: MaterializationTarget
  ): Promise<MaterializationResult> {
    const createdObjects: Array<{ object_kind: string; object_id: string }> = [];
    try {
      await this.preflightSignalRefFallback(signal);

      const materializedMemory = await this.createEvidenceBackedMemoryEntry(signal);
      createdObjects.push(...materializedMemory.createdObjects);

      return {
        signal_id: signal.signal_id,
        // wire-level kind stays evidence_only so the cross-package
        // SignalMaterializationTargetKind union does not need to widen;
        // memory_entry_only is surfaced through route_target.
        // see also: packages/core/src/memory/signal-service.ts SignalMaterializationTargetKind
        target_kind: "evidence_only",
        route_target: target.route_target,
        routing_reason: target.routing_reason,
        created_objects: createdObjects,
        success: true
      };
    } catch (error) {
      createdObjects.push(...readPartialFailureCreatedObjects(error));
      return {
        signal_id: signal.signal_id,
        target_kind: "evidence_only",
        route_target: target.route_target,
        routing_reason: target.routing_reason,
        created_objects: createdObjects,
        success: false,
        error: readErrorMessage(error, "Unknown materialization error")
      };
    }
  }

  protected async createEvidenceBackedMemoryEntry(
    signal: CandidateMemorySignal
  ): Promise<MemoryEntryMaterialization> {
    await this.preflightSignalRefFallback(signal);

    const createdObjects: MaterializationCreatedObject[] = [];
    const evidence = await this.dependencies.evidenceService.create(
      buildEvidenceInput(signal, undefined, {
        fullTurnExcerpt: this.dependencies.fullTurnEvidenceExcerpt
      })
    );
    createdObjects.push({ object_kind: evidence.object_kind, object_id: evidence.object_id });

    let memory: MemoryMaterializationCreatedObject;
    try {
      memory = await this.dependencies.memoryService.create(
        buildMemoryInput(signal, [evidence.object_id], this.enrichmentIntent(signal), this.dependencies.deriveFacetTags === true)
      );
    } catch (error) {
      try {
        await this.dependencies.evidenceService.deleteCreatedEvidence(evidence.object_id);
      } catch (compensationError) {
        throw new MaterializationPartialFailureError(
          readErrorMessage(compensationError, "Evidence compensation failed after memory materialization failed"),
          createdObjects,
          { cause: compensationError }
        );
      }
      throw new MaterializationPartialFailureError(
        readErrorMessage(error, "Memory materialization failed after evidence creation"),
        [],
        { cause: error }
      );
    }
    createdObjects.push({ object_kind: memory.object_kind, object_id: memory.object_id });

    this.enqueueEnrichmentAfterCreate(memory, signal);
    createdObjects.push(
      ...(await this.createAllMemoryRefEdgesBestEffort(
        memory.object_id,
        signal,
        this.isSignalRefRetryAvailable(memory)
      ))
    );

    const timeConcernProposal = await this.createTimeConcernProposalBestEffort(memory.object_id, signal);
    if (timeConcernProposal !== null) {
      createdObjects.push(timeConcernProposal);
    }

    return { evidence, memory, createdObjects };
  }

  // invariant: decide-then-create ingest path. The core service computes
  // the verdict FIRST, then calls the applyVerdict callback inside its
  // per-workspace lock. The callback creates objects strictly per
  // verdict: ADD -> evidence_capsule + memory_entry; UPDATE ->
  // evidence_capsule only (the core service then rewrites the target row
  // and relinks the ref); NOOP -> nothing. NOOP minting no fresh capsule
  // is what keeps a re-seed of the same haystack idempotent.
  //
  // The evidence_capsule is created lazily and at most once: on a rare
  // UPDATE-apply failure the core service re-invokes applyVerdict with a
  // degraded ADD verdict, and the cached capsule ref is reused so the
  // memory_entry is appended against the already-created evidence.
  protected async materializeReconciledMemoryEntry(
    signal: CandidateMemorySignal,
    target: MaterializationTarget,
    port: ReconciliationPort
  ): Promise<MaterializationResult> {
    const state = this.createReconciledMaterializationState();

    try {
      const decision = await this.runReconciledDecision(signal, port, state);
      await this.finalizeReconciledAppend(signal, state);
      return this.buildReconciledMaterializationResult(signal, target, decision, state);
    } catch (error) {
      return await this.handleReconciledMaterializationFailure(signal, target, error);
    }
  }

  protected createReconciledMaterializationState(): ReconciledMaterializationState {
    return { createdObjects: [] };
  }

  protected async runReconciledDecision(
    signal: CandidateMemorySignal,
    port: ReconciliationPort,
    state: ReconciledMaterializationState
  ) {
    const incomingContent = buildDistilledFact(signal);
    const { facet_tags: incomingFacetTags } = buildFacetTagsProjection(
      incomingContent,
      this.dependencies.deriveFacetTags === true
    );
    return await port.runWithDecision(
      {
        workspaceId: signal.workspace_id,
        runId: signal.run_id,
        signalId: signal.signal_id,
        incomingContent,
        incomingDomainTags: signal.domain_tags,
        incomingProjectionFields: readReconciliationProjectionFields(
          buildMemoryInput(signal, [], this.enrichmentIntent(signal))
        ),
        ...(incomingFacetTags === undefined ? {} : { incomingFacetTags })
      },
      async (verdict) => await this.applyReconciledVerdict(signal, verdict, state)
    );
  }

  protected async applyReconciledVerdict(
    signal: CandidateMemorySignal,
    verdict: { readonly kind: "add" | "update" | "noop" },
    state: ReconciledMaterializationState
  ): Promise<{ readonly incomingEvidenceRef?: string }> {
    if (verdict.kind === "noop") {
      return {};
    }
    const evidenceRef = await this.ensureReconciledEvidence(signal, state);
    if (verdict.kind === "update") {
      return { incomingEvidenceRef: evidenceRef };
    }
    await this.preflightSignalRefFallback(signal);
    state.appendedMemory = await this.dependencies.memoryService.create(
      buildMemoryInput(signal, [evidenceRef], this.enrichmentIntent(signal), this.dependencies.deriveFacetTags === true)
    );
    state.createdObjects.push({
      object_kind: state.appendedMemory.object_kind,
      object_id: state.appendedMemory.object_id
    });
    return { incomingEvidenceRef: evidenceRef };
  }

  protected async ensureReconciledEvidence(
    signal: CandidateMemorySignal,
    state: ReconciledMaterializationState
  ): Promise<string> {
    if (state.evidenceId !== undefined) {
      return state.evidenceId;
    }
    const evidence = await this.dependencies.evidenceService.create(
      buildEvidenceInput(signal, undefined, {
        fullTurnExcerpt: this.dependencies.fullTurnEvidenceExcerpt
      })
    );
    state.evidenceId = evidence.object_id;
    state.createdObjects.push({
      object_kind: evidence.object_kind,
      object_id: evidence.object_id
    });
    return state.evidenceId;
  }

  protected async finalizeReconciledAppend(
    signal: CandidateMemorySignal,
    state: ReconciledMaterializationState
  ): Promise<void> {
    if (state.appendedMemory === undefined) {
      return;
    }
    this.enqueueEnrichmentAfterCreate(state.appendedMemory, signal);
    state.createdObjects.push(
      ...(await this.createAllMemoryRefEdgesBestEffort(
        state.appendedMemory.object_id,
        signal,
        this.isSignalRefRetryAvailable(state.appendedMemory)
      ))
    );
    const timeConcernProposal = await this.createTimeConcernProposalBestEffort(
      state.appendedMemory.object_id,
      signal
    );
    if (timeConcernProposal !== null) {
      state.createdObjects.push(timeConcernProposal);
    }
  }

  protected buildReconciledMaterializationResult(
    signal: CandidateMemorySignal,
    target: MaterializationTarget,
    decision: { readonly kind: "add" | "update" | "noop"; readonly reason: string; readonly survivingObjectId?: string },
    state: ReconciledMaterializationState
  ): MaterializationResult {
    const createdObjects =
      decision.kind !== "add" && decision.survivingObjectId !== undefined
        ? [
            ...state.createdObjects,
            { object_kind: "memory_entry", object_id: decision.survivingObjectId }
          ]
        : state.createdObjects;
    return {
      signal_id: signal.signal_id,
      target_kind: "evidence_only",
      route_target: target.route_target,
      routing_reason:
        decision.kind === "add"
          ? target.routing_reason
          : `${target.routing_reason} — reconciled: ${decision.reason}`,
      created_objects: createdObjects,
      success: true
    };
  }

  protected async handleReconciledMaterializationFailure(
    signal: CandidateMemorySignal,
    target: MaterializationTarget,
    error: unknown
  ): Promise<MaterializationResult> {
    // A reconciliation backend failure must never drop the fact: fall back to
    // the unchanged blind-append path. A partial applyVerdict can orphan at
    // most one evidence capsule, but it cannot lose the fact.
    console.warn("materialization-router: reconciliation failed", {
      signalId: signal.signal_id,
      error: error instanceof Error ? error.message : String(error)
    });
    return await this.materializeMemoryEntryAppend(signal, target);
  }

  // invariant: write-path/enrich-path decouple (S3c). The durable enrich_pending
  // marker is the mandatory no-drop handoff between the synchronous write-path
  // and the Garden BULK_ENRICH worker (which reconstructs the conflict-scan
  // params from the persisted memory row — content/dimension/scope/domain_tags
  // match buildMemoryInput exactly — and runs ConflictDetectionService
  // .detectAndLinkConflicts + EdgeAutoProducer off-path). The PREFERRED enqueue
  // path is atomic: the memory-create port commits the row + the marker in one
  // transaction (enrichmentIntent on the create input), so a created memory
  // ALWAYS carries its marker. enrichmentIntent returns undefined only when no
  // enrichPendingPort is wired (enrichment disabled, same as an absent service).
  // invariant: conflict suppression (contradicts/supersedes edges) is now
  // best-effort-eventual, not synchronous-at-materialize. A freshly materialized
  // memory is recallable before its not-yet-detected contradiction/supersession
  // edges form — surfaced != conflict-checked within that window. The Garden
  // drains every BULK_ENRICH queued in a ~60s GardenScheduler pass (up to a
  // bounded per-pass cap), so the upper bound is ~1 min per workspace up to the
  // cap, and O(workspaces / cap) * ~1 min beyond it.
  // see also: packages/storage/src/repos/enrich-pending-repo.ts
  // see also: apps/core-daemon/src/garden-runtime.ts runBulkEnrichTask.
  protected enrichmentIntent(
    signal: CandidateMemorySignal
  ): MemoryMaterializationInput["enqueueEnrichment"] {
    if (this.dependencies.enrichPendingPort === undefined) {
      return undefined;
    }
    return buildEnrichmentIntent(signal);
  }

  // invariant: loud no-drop fallback. The atomic create+enqueue is the primary
  // path (enrichmentIntent). This fires ONLY when the wired memory-create port
  // did not honor the atomic seam (enrichmentEnqueued !== true) yet an
  // enrichPendingPort is wired — the marker is mandatory, so a failure here
  // must surface (the caller's catch flips the branch to success:false → the
  // signal is marked FAILED rather than leaving a memory stranded with no
  // marker). NOT warn-and-continue: that swallow is the bug B6's intent must
  // not reintroduce. The genuinely-optional time_concern proposal keeps its
  // warn-and-continue (createTimeConcernProposalBestEffort) — this does not.
  // see also: packages/core/src/memory/signal-service.ts terminal-FAILED on success!=true
  protected enqueueEnrichmentAfterCreate(
    memory: MemoryMaterializationCreatedObject,
    signal: CandidateMemorySignal
  ): void {
    if (memory.enrichmentEnqueued === true) {
      return;
    }
    const port = this.dependencies.enrichPendingPort;
    if (port === undefined) {
      return;
    }
    port.enqueue({
      workspaceId: signal.workspace_id,
      memoryId: memory.object_id,
      runId: signal.run_id,
      sourceSignalId: signal.signal_id
    });
  }

  protected isSignalRefRetryAvailable(memory: MemoryMaterializationCreatedObject): boolean {
    return memory.enrichmentEnqueued === true || this.dependencies.enrichPendingPort !== undefined;
  }

}

function readPartialFailureCreatedObjects(error: unknown): readonly MaterializationCreatedObject[] {
  return error instanceof MaterializationPartialFailureError ? error.createdObjects : [];
}

function readReconciliationProjectionFields(
  input: MemoryMaterializationInput
): NonNullable<Parameters<ReconciliationPort["runWithDecision"]>[0]["incomingProjectionFields"]> {
  return {
    projection_schema_version: input.projection_schema_version,
    event_time_start: input.event_time_start,
    event_time_end: input.event_time_end,
    valid_from: input.valid_from,
    valid_to: input.valid_to,
    time_precision: input.time_precision,
    time_source: input.time_source,
    preference_subject: input.preference_subject,
    preference_predicate: input.preference_predicate,
    preference_object: input.preference_object,
    preference_category: input.preference_category,
    preference_polarity: input.preference_polarity,
    // sourced from buildCanonicalEntitiesProjection via buildMemoryInput; refreshes UPDATE / backfills NOOP survivors.
    canonical_entities: input.canonical_entities
  };
}
