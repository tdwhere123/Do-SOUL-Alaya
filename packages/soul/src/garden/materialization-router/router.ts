import {
  readErrorMessage,
  type CandidateMemorySignal
} from "@do-soul/alaya-protocol";
import {
  type HandoffGapCreatedObject,
  type HandoffGapHandler
} from "../handoff-gap-handler.js";
import { validateSchemaGroundingForSignal } from "../schema-grounding.js";
import {
  type MaterializationCreatedObject,
  type MaterializationResult,
  type MaterializationRouterDeps,
  type MaterializationTarget,
  type MemoryMaterializationCreatedObject,
  type MemoryMaterializationInput,
  type PathCandidateMintOutcome,
  type ReconciliationPort,
  type SignalRefSeedSpec,
  type SignalRefTransientFailureMode
} from "./contracts.js";
import {
  buildClaimInput,
  buildDistilledFact,
  buildEnrichmentIntent,
  buildEvidenceInput,
  buildFailedSignalRefPathRelationProposal,
  buildFailedSignalRefPathRelationProposalReason,
  buildMemoryInput,
  buildSynthesisInput,
  buildTimeConcernPathRelationProposal,
  collectMaterializableSignalMemoryRefs,
  hasMaterializableSignalMemoryRefs,
  readStringPayload,
  readTimeConcernPayload,
  routeByObjectKind
} from "./inputs.js";
import { SIGNAL_REF_SEED_SPECS } from "./signal-ref-seeds.js";

export class MaterializationRouter {
  private readonly handoffGapHandler: HandoffGapHandler;

  public constructor(private readonly dependencies: MaterializationRouterDeps) {
    this.handoffGapHandler = dependencies.handoffGapHandler;
  }

  public async replaySignalRefs(input: {
    readonly newObjectId: string;
    readonly signal: CandidateMemorySignal;
  }): Promise<readonly MaterializationCreatedObject[]> {
    if (
      this.dependencies.pathCandidateSinkPort === undefined &&
      hasMaterializableSignalMemoryRefs(input.signal)
    ) {
      throw new Error("PathCandidateSinkPort unavailable during signal-ref replay.");
    }
    return await this.createAllMemoryRefEdges(
      input.newObjectId,
      input.signal,
      "throw_for_retry"
    );
  }

  public route(signal: CandidateMemorySignal): MaterializationTarget {
    const schemaGroundingValidation = validateSchemaGroundingForSignal(signal);
    if (schemaGroundingValidation.declared && schemaGroundingValidation.status !== "valid") {
      return {
        kind: "deferred",
        route_target: "deferred",
        routing_reason: `schema-grounded signal failed validation: ${schemaGroundingValidation.reasons.join("; ")}`
      };
    }

    if (signal.signal_kind === "potential_synthesis" && signal.evidence_refs.length >= 2) {
      return {
        kind: "synthesis",
        route_target: "synthesis",
        routing_reason: "multi-evidence synthesis candidate"
      };
    }

    if (signal.signal_kind === "potential_handoff") {
      return {
        kind: "handoff_gap",
        route_target: "handoff_gap",
        routing_reason: "run-bound handoff/gap detection"
      };
    }

    if (signal.signal_kind === "potential_evidence_anchor") {
      return {
        kind: "evidence_only",
        route_target: "evidence_only",
        routing_reason: "evidence archival"
      };
    }

    // invariant: potential_conflict routes to ConflictDetectionPort.evaluate
    // instead of the questionable-evidence fallback. Conflict signals
    // describe an alleged disagreement between memories — evaluate is
    // the producer of the contradicts / incompatible_with edges and is
    // the only sink that turns the signal into governance-actionable
    // structure. When the port is absent the signal is deferred (rather
    // than archived as questionable evidence), so the conflict surface
    // never silently degrades into noise.
    if (signal.signal_kind === "potential_conflict") {
      return {
        kind: "deferred",
        route_target: "conflict_evaluation",
        routing_reason: "potential_conflict -> ConflictDetectionPort.evaluate"
      };
    }

    if (signal.signal_kind === "potential_claim" && signal.object_kind === "path_relation") {
      return {
        kind: "deferred",
        route_target: "path_relation_proposal",
        routing_reason: "object_kind=path_relation -> path_relation_proposal"
      };
    }

    const materializationConfidenceFloor =
      this.dependencies.materializationConfidenceFloor ?? 0.5;
    if (
      (signal.signal_kind === "potential_claim" || signal.signal_kind === "potential_preference") &&
      signal.confidence >= materializationConfidenceFloor
    ) {
      const objectKindRoute = routeByObjectKind(signal.object_kind);
      if (objectKindRoute !== null) {
        return objectKindRoute;
      }
      // invariant: unknown object_kind never enters governance review as
      // a draft claim — that would re-introduce the producer-side claim
      // collapse the routing table was meant to break. Known claim-
      // capable dimensions are enumerated in routeByObjectKind; anything
      // outside the table is archived as questionable evidence only.
      // retainUnroutedHighConfidenceFacts keeps the fact recallable as a
      // memory_entry_only (a memory with NO draft claim, so the claim/
      // governance surface stays unpolluted) — the same route `fact` takes.
      if (this.dependencies.retainUnroutedHighConfidenceFacts === true) {
        return {
          kind: "evidence_only",
          route_target: "memory_entry_only",
          routing_reason: `high-confidence ${signal.signal_kind} with unrouted object_kind=${signal.object_kind} -> memory_entry_only (retain-unrouted-facts)`
        };
      }
      return {
        kind: "evidence_only",
        route_target: "evidence_only",
        routing_reason: `high-confidence ${signal.signal_kind} with unrouted object_kind=${signal.object_kind} -> evidence_only`
      };
    }

    // Low-confidence unroutable signals are deferred rather than persisted as
    // questionable evidence — avoids accumulating low-confidence noise.
    if (signal.confidence < 0.3) {
      return {
        kind: "deferred",
        route_target: "deferred",
        routing_reason: "uncertain signal — deferred pending higher-confidence reconfirmation"
      };
    }

    return {
      kind: "evidence_only",
      route_target: "evidence_only",
      // invariant: unroutable signals are archived as questionable evidence only;
      // they do not produce verified long-term objects (invariant #16).
      routing_reason: "unroutable signal -> evidence archive (questionable evidence only)"
    };
  }

  public async materializeSignal(signal: CandidateMemorySignal): Promise<MaterializationResult> {
    return await this.materialize(signal, this.route(signal));
  }

  public async materialize(
    signal: CandidateMemorySignal,
    target: MaterializationTarget
  ): Promise<MaterializationResult> {
    if (target.route_target === "memory_entry_only") {
      return await this.materializeMemoryEntryOnly(signal, target);
    }
    if (target.route_target === "conflict_evaluation") {
      return await this.materializeConflictEvaluation(signal, target);
    }
    if (target.route_target === "path_relation_proposal") {
      return await this.materializePathRelationProposal(signal, target);
    }
    if (target.route_target === "signal_only") {
      return this.materializeDeferred(signal, target);
    }

    switch (target.kind) {
      case "memory_and_claim":
        return await this.materializeMemoryAndClaim(signal, target);
      case "synthesis":
        return await this.materializeSynthesis(signal, target);
      case "handoff_gap":
        return await this.materializeHandoffGap(signal, target);
      case "evidence_only":
        return await this.materializeEvidenceOnly(signal, target);
      case "deferred":
        return this.materializeDeferred(signal, target);
      default: {
        const exhaustiveCheck: never = target.kind;
        return {
          signal_id: signal.signal_id,
          target_kind: exhaustiveCheck,
          route_target: target.route_target,
          routing_reason: target.routing_reason,
          created_objects: [],
          success: false,
          error: "Unsupported materialization target"
        };
      }
    }
  }

  // invariant: ingest reconciliation covers the materializeMemoryEntryOnly
  // path only (the bench `fact` object_kind). materialize_and_claim is
  // intentionally NOT reconciled — a claim-bearing signal
  // carries governance structure whose dedup is the conflict / claim
  // surface's job, not the lexical ingest gate.
  private async materializeMemoryAndClaim(
    signal: CandidateMemorySignal,
    target: MaterializationTarget
  ): Promise<MaterializationResult> {
    const createdObjects: Array<{ object_kind: string; object_id: string }> = [];

    try {
      await this.preflightSignalRefFallback(signal);

      const evidence = await this.dependencies.evidenceService.create(buildEvidenceInput(signal, undefined, { fullTurnExcerpt: this.dependencies.fullTurnEvidenceExcerpt }));
      createdObjects.push({ object_kind: evidence.object_kind, object_id: evidence.object_id });

      const memory = await this.dependencies.memoryService.create(
        buildMemoryInput(signal, [evidence.object_id], this.enrichmentIntent(signal))
      );
      createdObjects.push({ object_kind: memory.object_kind, object_id: memory.object_id });

      const claim = await this.dependencies.claimService.create(
        buildClaimInput(signal, [evidence.object_id], [memory.object_id])
      );
      createdObjects.push({ object_kind: claim.object_kind, object_id: claim.object_id });

      // invariant: enqueue-not-inline + no-drop. The durable enrich_pending
      // marker is committed atomically with the memory row (enrichmentIntent on
      // the create input); this loud fallback only fires when the wired port did
      // not honor the atomic seam, and it precedes every optional, throw-capable
      // side effect below so a freshly materialized memory is never stranded
      // without enrichment. Edge auto-production + conflict detection run
      // off-path in the BULK_ENRICH worker. see enqueueEnrichmentAfterCreate.
      this.enqueueEnrichmentAfterCreate(memory, signal);

      createdObjects.push(
        ...(await this.createAllMemoryRefEdgesBestEffort(
          memory.object_id,
          signal,
          this.isSignalRefRetryAvailable(memory)
        ))
      );
      const timeConcernProposal = await this.createTimeConcernProposalBestEffort(
        memory.object_id,
        signal
      );
      if (timeConcernProposal !== null) {
        createdObjects.push(timeConcernProposal);
      }

      return {
        signal_id: signal.signal_id,
        target_kind: target.kind,
        route_target: target.route_target,
        routing_reason: target.routing_reason,
        created_objects: createdObjects,
        success: true
      };
    } catch (error) {
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

  private async materializeSynthesis(
    signal: CandidateMemorySignal,
    target: MaterializationTarget
  ): Promise<MaterializationResult> {
    const createdObjects: Array<{ object_kind: string; object_id: string }> = [];

    try {
      const evidenceCount = Math.max(2, signal.evidence_refs.length);
      const evidenceInputs = Array.from({ length: evidenceCount }, (_, index) =>
        buildEvidenceInput(signal, `signal_ref_${index + 1}`, {
          fullTurnExcerpt: this.dependencies.fullTurnEvidenceExcerpt
        })
      );

      const evidences = await Promise.all(
        evidenceInputs.map(async (evidenceInput) => await this.dependencies.evidenceService.create(evidenceInput))
      );

      const evidenceIds = evidences.map((evidence) => evidence.object_id);
      for (const evidence of evidences) {
        createdObjects.push({ object_kind: evidence.object_kind, object_id: evidence.object_id });
      }

      const synthesis = await this.dependencies.synthesisService.create(
        buildSynthesisInput(signal, evidenceIds)
      );
      createdObjects.push({ object_kind: synthesis.object_kind, object_id: synthesis.object_id });

      // No graph relation here: the path plane anchors on memory_entries, and a
      // synthesis_capsule id is not a memory endpoint. The synthesis↔memory
      // relation is carried by synthesis.evidence_refs (which point at evidence
      // ids) and by claim resolution downstream. A synthesis-to-memory
      // provenance relation would need a deliberate anchor-domain change.

      return {
        signal_id: signal.signal_id,
        target_kind: target.kind,
        route_target: target.route_target,
        routing_reason: target.routing_reason,
        created_objects: createdObjects,
        success: true
      };
    } catch (error) {
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

  private async materializeHandoffGap(
    signal: CandidateMemorySignal,
    target: MaterializationTarget
  ): Promise<MaterializationResult> {
    try {
      const createdObject: HandoffGapCreatedObject = this.handoffGapHandler.createFromSignal(signal);

      return {
        signal_id: signal.signal_id,
        target_kind: target.kind,
        route_target: target.route_target,
        routing_reason: target.routing_reason,
        created_objects: [createdObject],
        success: true
      };
    } catch (error) {
      return {
        signal_id: signal.signal_id,
        target_kind: target.kind,
        route_target: target.route_target,
        routing_reason: target.routing_reason,
        created_objects: [],
        success: false,
        error: readErrorMessage(error, "Unknown materialization error")
      };
    }
  }

  /** Returns a deferred result without persisting anything. */
  private materializeDeferred(
    signal: CandidateMemorySignal,
    target: MaterializationTarget
  ): MaterializationResult {
    return {
      signal_id: signal.signal_id,
      target_kind: "deferred",
      route_target: target.route_target,
      routing_reason: target.routing_reason,
      created_objects: [],
      success: true
    };
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
  private async materializeMemoryEntryOnly(
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
  private async materializeMemoryEntryAppend(
    signal: CandidateMemorySignal,
    target: MaterializationTarget
  ): Promise<MaterializationResult> {
    const createdObjects: Array<{ object_kind: string; object_id: string }> = [];
    try {
      await this.preflightSignalRefFallback(signal);

      const evidence = await this.dependencies.evidenceService.create(buildEvidenceInput(signal, undefined, { fullTurnExcerpt: this.dependencies.fullTurnEvidenceExcerpt }));
      createdObjects.push({ object_kind: evidence.object_kind, object_id: evidence.object_id });

      const memory = await this.dependencies.memoryService.create(
        buildMemoryInput(signal, [evidence.object_id], this.enrichmentIntent(signal))
      );
      createdObjects.push({ object_kind: memory.object_kind, object_id: memory.object_id });

      // invariant: enqueue-not-inline + no-drop. The durable enrich_pending
      // marker is committed atomically with the memory row; this loud fallback
      // only fires when the wired port did not honor the atomic seam, and it
      // precedes every optional, throw-capable side effect below.
      // see enqueueEnrichmentAfterCreate.
      this.enqueueEnrichmentAfterCreate(memory, signal);

      createdObjects.push(
        ...(await this.createAllMemoryRefEdgesBestEffort(
          memory.object_id,
          signal,
          this.isSignalRefRetryAvailable(memory)
        ))
      );

      const timeConcernProposal = await this.createTimeConcernProposalBestEffort(
        memory.object_id,
        signal
      );
      if (timeConcernProposal !== null) {
        createdObjects.push(timeConcernProposal);
      }

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
  private async materializeReconciledMemoryEntry(
    signal: CandidateMemorySignal,
    target: MaterializationTarget,
    port: ReconciliationPort
  ): Promise<MaterializationResult> {
    const createdObjects: Array<{ object_kind: string; object_id: string }> = [];
    let evidenceId: string | undefined;
    let appendedMemory: MemoryMaterializationCreatedObject | undefined;

    const ensureEvidence = async (): Promise<string> => {
      if (evidenceId === undefined) {
        const evidence = await this.dependencies.evidenceService.create(buildEvidenceInput(signal, undefined, { fullTurnExcerpt: this.dependencies.fullTurnEvidenceExcerpt }));
        evidenceId = evidence.object_id;
        createdObjects.push({ object_kind: evidence.object_kind, object_id: evidence.object_id });
      }
      return evidenceId;
    };

    try {
      const decision = await port.runWithDecision(
        {
          workspaceId: signal.workspace_id,
          runId: signal.run_id,
          signalId: signal.signal_id,
          incomingContent: buildDistilledFact(signal),
          incomingDomainTags: signal.domain_tags
        },
        async (verdict) => {
          if (verdict.kind === "noop") {
            // NOOP creates nothing — no evidence_capsule, no
            // memory_entry. There is no orphan to relink.
            return {};
          }
          if (verdict.kind === "update") {
            // The core service rewrites the target row and relinks this
            // ref; the router creates no memory_entry on this branch.
            const evidenceRef = await ensureEvidence();
            return { incomingEvidenceRef: evidenceRef };
          }
          await this.preflightSignalRefFallback(signal);
          const evidenceRef = await ensureEvidence();
          // ADD: append the memory_entry against the fresh evidence. The
          // enrich_pending marker commits atomically with the row.
          const memory = await this.dependencies.memoryService.create(
            buildMemoryInput(signal, [evidenceRef], this.enrichmentIntent(signal))
          );
          appendedMemory = memory;
          createdObjects.push({ object_kind: memory.object_kind, object_id: memory.object_id });
          return { incomingEvidenceRef: evidenceRef };
        }
      );

      // invariant: DELETE / supersede is the ConflictDetectionService's job —
      // its detectAndLinkConflicts now runs in the BULK_ENRICH worker, not
      // inline. Only an ADD mints a new memory_entry endpoint; UPDATE / NOOP
      // reuse an existing row and enqueue nothing (no fresh enrichment target).
      if (appendedMemory !== undefined) {
        const appendedMemoryId = appendedMemory.object_id;
        // invariant: enqueue-not-inline + no-drop. The durable enrich_pending
        // marker is committed atomically with the memory row; this loud fallback
        // only fires when the wired port did not honor the atomic seam, and it
        // precedes every optional, throw-capable side effect below.
        // see enqueueEnrichmentAfterCreate.
        this.enqueueEnrichmentAfterCreate(appendedMemory, signal);

        createdObjects.push(
          ...(await this.createAllMemoryRefEdgesBestEffort(
            appendedMemoryId,
            signal,
            this.isSignalRefRetryAvailable(appendedMemory)
          ))
        );
        const timeConcernProposal = await this.createTimeConcernProposalBestEffort(
          appendedMemoryId,
          signal
        );
        if (timeConcernProposal !== null) {
          createdObjects.push(timeConcernProposal);
        }
      }

      const reconciledObjects =
        decision.kind !== "add" && decision.survivingObjectId !== undefined
          ? [
              ...createdObjects,
              { object_kind: "memory_entry", object_id: decision.survivingObjectId }
            ]
          : createdObjects;

      return {
        signal_id: signal.signal_id,
        target_kind: "evidence_only",
        route_target: target.route_target,
        routing_reason:
          decision.kind === "add"
            ? target.routing_reason
            : `${target.routing_reason} — reconciled: ${decision.reason}`,
        created_objects: reconciledObjects,
        success: true
      };
    } catch (error) {
      // A reconciliation backend failure must never drop the fact:
      // fall back to the unchanged blind-append path. The evidence
      // capsule may already exist from a partial applyVerdict run; the
      // append path mints its own, so a transient failure costs at most
      // one orphan capsule, never a lost fact.
      console.warn("materialization-router: reconciliation failed", {
        signalId: signal.signal_id,
        error: error instanceof Error ? error.message : String(error)
      });
      return await this.materializeMemoryEntryAppend(signal, target);
    }
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
  private enrichmentIntent(
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
  private enqueueEnrichmentAfterCreate(
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

  private isSignalRefRetryAvailable(memory: MemoryMaterializationCreatedObject): boolean {
    return memory.enrichmentEnqueued === true || this.dependencies.enrichPendingPort !== undefined;
  }

  private async materializePathRelationProposal(
    signal: CandidateMemorySignal,
    target: MaterializationTarget
  ): Promise<MaterializationResult> {
    const targetObjectId = readStringPayload(signal.raw_payload, "target_object_id");
    if (targetObjectId === null) {
      return {
        signal_id: signal.signal_id,
        target_kind: "deferred",
        route_target: target.route_target,
        routing_reason: `${target.routing_reason} — deferred: target_object_id missing`,
        created_objects: [],
        success: true
      };
    }

    const created = await this.createTimeConcernPathRelationProposal(targetObjectId, signal);
    return {
      signal_id: signal.signal_id,
      target_kind: "deferred",
      route_target: target.route_target,
      routing_reason: target.routing_reason,
      created_objects: created === null ? [] : [created],
      success: true
    };
  }

  // invariant: optional-side-effect isolation. On a memory-creating branch the
  // memory row + its enrich_pending marker are already durable before this
  // runs, so a time_concern proposal failure must warn-and-continue: a throw
  // here may never flip the branch to success: false (which SignalService would
  // mark terminally FAILED) nor strand the memory without enrichment.
  // see also: packages/core/src/memory/signal-service.ts terminal-FAILED on success!=true
  private async createTimeConcernProposalBestEffort(
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

  private async createTimeConcernPathRelationProposal(
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

  private async preflightSignalRefFallback(signal: CandidateMemorySignal): Promise<void> {
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

  // invariant: potential_conflict route sink. evaluate is the only
  // producer for contradicts / incompatible_with edges that originates
  // from a raw signal (memory-time detection runs through
  // detectAndLinkConflicts after the new memory is created). When the
  // port is absent or lacks evaluate, the signal is deferred so the
  // conflict surface is not silently lost as questionable evidence.
  private async materializeConflictEvaluation(
    signal: CandidateMemorySignal,
    target: MaterializationTarget
  ): Promise<MaterializationResult> {
    const port = this.dependencies.conflictDetectionPort;
    if (port === undefined || port.evaluate === undefined) {
      return {
        signal_id: signal.signal_id,
        target_kind: "deferred",
        route_target: target.route_target,
        routing_reason: `${target.routing_reason} — deferred: evaluate unavailable`,
        created_objects: [],
        success: true
      };
    }

    try {
      await port.evaluate({
        signalId: signal.signal_id,
        workspaceId: signal.workspace_id,
        runId: signal.run_id,
        objectKind: signal.object_kind,
        scopeHint: signal.scope_hint,
        content: buildDistilledFact(signal),
        domainTags: signal.domain_tags
      });

      return {
        signal_id: signal.signal_id,
        target_kind: "deferred",
        route_target: target.route_target,
        routing_reason: target.routing_reason,
        created_objects: [],
        success: true
      };
    } catch (error) {
      return {
        signal_id: signal.signal_id,
        target_kind: "deferred",
        route_target: target.route_target,
        routing_reason: target.routing_reason,
        created_objects: [],
        success: false,
        error: readErrorMessage(error, "Unknown materialization error")
      };
    }
  }

  /**
   * Submits a governed path candidate for every first-class memory ref
   * carried by a memory-creating signal. A permanent "rejected" never blocks
   * materialization of the memory itself. A transient "failed" or thrown sink
   * must either leave a durable proposal record or remain retryable through the
   * enrich_pending marker. This also activates the historically dormant
   * signal-ref edge source — the refs now flow through PathRelationProposalService.
   */
  private async createAllMemoryRefEdges(
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
  private async submitCandidatesFromSignalRefs(
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

  private async createAllMemoryRefEdgesBestEffort(
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

  private async createFailedSignalRefPathRelationProposal(params: {
    readonly newObjectId: string;
    readonly failedRef: string;
    readonly signal: CandidateMemorySignal;
    readonly spec: SignalRefSeedSpec;
    readonly thrownError: string | null;
  }): Promise<MaterializationCreatedObject> {
    const port = this.dependencies.pathRelationProposalPort;
    if (port === undefined) {
      throw new Error(
        `PathRelationProposalPort unavailable after failed ${params.spec.signalRefsKey} path candidate for ${params.failedRef}`
      );
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

  private async materializeEvidenceOnly(
    signal: CandidateMemorySignal,
    target: MaterializationTarget
  ): Promise<MaterializationResult> {
    try {
      const evidence = await this.dependencies.evidenceService.create(buildEvidenceInput(signal, undefined, { fullTurnExcerpt: this.dependencies.fullTurnEvidenceExcerpt }));

      return {
        signal_id: signal.signal_id,
        target_kind: target.kind,
        route_target: target.route_target,
        routing_reason: target.routing_reason,
        created_objects: [{ object_kind: evidence.object_kind, object_id: evidence.object_id }],
        success: true
      };
    } catch (error) {
      return {
        signal_id: signal.signal_id,
        target_kind: target.kind,
        route_target: target.route_target,
        routing_reason: target.routing_reason,
        created_objects: [],
        success: false,
        error: readErrorMessage(error, "Unknown materialization error")
      };
    }
  }
}
