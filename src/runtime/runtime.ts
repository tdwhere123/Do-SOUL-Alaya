import { createHash, randomUUID } from "node:crypto";
import { createDoctorReport } from "../doctor/report.js";
import { SqliteAlayaStorage } from "../storage/sqlite.js";
import { executeAuditedMutation as executeWithAuditLog } from "./audited-mutation.js";
import type {
  AuditedMutationInput,
  AuditedMutationResult
} from "./audit-types.js";
import { InvalidRuntimeDecisionKindError } from "./audit-types.js";
import type {
  AlayaRuntimeOptions,
  AlayaRuntimePort,
  AuditedContextPackInput,
  AuditedGovernanceActionInput,
  AuditedGovernanceBypassInput,
  AuditedManifestationResolveInput,
  AuditedMemorySessionEventInput,
  AuditedMemoryVisibilityInput,
  AuditedOntologyWriteInput,
  AuditedPathRelationWriteInput,
  AuditedPromotionDecisionInput,
  AuditedProposalRecordInput,
  AuditedProviderSelectionInput,
  AuditedRecallContextInput,
  AuditedRuntimeDecisionInput,
  AuditedRuntimeDecisionReceipt,
  AuditedTrustSummaryInput
} from "./types.js";
import type { DoctorReport } from "../doctor/report.js";
import type {
  ClaimForm,
  EvidenceCapsule,
  MemoryEntry,
  OntologyRecord,
  SynthesisCapsule
} from "../ontology/index.js";
import {
  assertEvidenceCanSupportDurableWrite,
  validateClaimForm,
  validateEvidenceCapsule,
  validateMemoryEntry,
  validateOntologyRecord,
  validateSynthesisCapsule
} from "../ontology/index.js";
import type {
  ManifestationDecision,
  PathAnchorRef,
  PathRelation,
  TopologyProjection
} from "../structure/index.js";
import {
  projectReadOnlyTopology,
  resolveManifestations,
  serializePathAnchorRef,
  validatePathRelation
} from "../structure/index.js";
import type {
  GovernanceBypassSignal,
  GovernancePolicyDecision,
  PromotionDecision
} from "../governance/index.js";
import {
  detectGovernanceBypass,
  evaluateGovernanceAction,
  evaluatePromotionGate
} from "../governance/index.js";
import type {
  ContextPack,
  RecallGovernanceState,
  RecallMemoryRecord
} from "../recall/index.js";
import {
  applyEmbeddingSupplement,
  assembleContextPack,
  mergePathRecallContributions,
  rankLexicalRecallCandidates
} from "../recall/index.js";
import type {
  ProposalValidationResult,
  ProviderSelectionRequest,
  ProviderSelectionResult
} from "../provider/index.js";
import {
  createRejectedProposalRecord,
  selectProviderForCapability,
  validateProposalRecord
} from "../provider/index.js";
import type { ProviderRegistryEntry } from "../provider/index.js";
import type {
  MemorySessionEvent,
  TrustSummary
} from "../session/index.js";
import {
  deriveTrustSummary,
  recordSessionEvent,
  validateContextDeliveryRecord,
  validateUsageProofRecord
} from "../session/index.js";
import type { JsonObject } from "./json.js";
import { redactJsonObject } from "./redaction.js";

export async function createAlayaRuntime(options: AlayaRuntimeOptions): Promise<AlayaRuntimePort> {
  const storage = await SqliteAlayaStorage.open(options);
  return new AlayaRuntime(storage);
}

class AlayaRuntime implements AlayaRuntimePort {
  public constructor(private readonly storage: SqliteAlayaStorage) {}

  public async recordAuditedRuntimeDecision(
    input: AuditedRuntimeDecisionInput
  ): Promise<AuditedMutationResult<AuditedRuntimeDecisionReceipt>> {
    assertRuntimeDecisionKind(input.kind);
    return await executeWithAuditLog(this.storage, input, ({ mutationId }) => ({
      mutationId,
      recorded: true,
      scope: "r1-runtime-audit"
    }));
  }

  public async createEvidenceCapsule(
    input: AuditedOntologyWriteInput<EvidenceCapsule>
  ): Promise<AuditedMutationResult<EvidenceCapsule>> {
    return this.createOntologyRecord(input, "ontology.evidence_capsule.create", validateEvidenceCapsule);
  }

  public async createMemoryEntry(
    input: AuditedOntologyWriteInput<MemoryEntry>
  ): Promise<AuditedMutationResult<MemoryEntry>> {
    return this.createOntologyRecord(input, "ontology.memory_entry.create", (record) => {
      const validated = validateMemoryEntry(record);
      this.assertUsableEvidenceRefs(validated.evidence_refs);
      return validated;
    });
  }

  public async createSynthesisCapsule(
    input: AuditedOntologyWriteInput<SynthesisCapsule>
  ): Promise<AuditedMutationResult<SynthesisCapsule>> {
    return this.createOntologyRecord(input, "ontology.synthesis_capsule.create", (record) => {
      const validated = validateSynthesisCapsule(record);
      this.assertUsableEvidenceRefs(validated.evidence_refs);
      for (const sourceRef of validated.source_memory_refs) {
        this.assertOntologyRecordExists("memory_entry", sourceRef);
      }
      return validated;
    });
  }

  public async createClaimForm(
    input: AuditedOntologyWriteInput<ClaimForm>
  ): Promise<AuditedMutationResult<ClaimForm>> {
    return this.createOntologyRecord(input, "ontology.claim_form.create", (record) => {
      const validated = validateClaimForm(record);
      this.assertUsableEvidenceRefs(validated.evidence_refs);
      for (const sourceRef of validated.source_object_refs) {
        this.assertAnyOntologyRecordExists(sourceRef);
      }
      return validated;
    });
  }

  public async createPathRelation(
    input: AuditedPathRelationWriteInput
  ): Promise<AuditedMutationResult<PathRelation>> {
    return await executeWithAuditLog(
      this.storage,
      buildAuditInput("structure.path_relation.create", input, {
        type: "path_relation",
        id: input.relation.path_id
      }, {
        path_id: input.relation.path_id,
        governance_class: input.relation.legitimacy.governance_class,
        governance_receipt: nullableJsonObject(input.governanceReceipt)
      }),
      () => {
        const relation = validatePathRelation(input.relation);
        this.assertUsableEvidenceRefs(relation.legitimacy.evidence_basis);
        this.assertPathAnchorsResolve(relation);
        this.assertPathGovernanceAllowsDurableWrite(relation, input.governanceReceipt ?? null);
        const record = this.storage.createPathRelationRecord({
          pathId: relation.path_id,
          workspaceId: relation.workspace_id,
          sourceAnchorKey: serializePathAnchorRef(relation.anchors.source_anchor),
          targetAnchorKey: serializePathAnchorRef(relation.anchors.target_anchor),
          lifecycleState: relation.lifecycle.state,
          anchors: relation.anchors as unknown as JsonObject,
          constitution: relation.constitution as unknown as JsonObject,
          effectVector: relation.effect_vector as unknown as JsonObject,
          plasticityState: relation.plasticity_state as unknown as JsonObject,
          lifecycle: relation.lifecycle as unknown as JsonObject,
          legitimacy: relation.legitimacy as unknown as JsonObject,
          payload: relation as unknown as JsonObject,
          createdAt: relation.created_at,
          updatedAt: relation.updated_at
        });
        return record.payload as unknown as PathRelation;
      }
    );
  }

  public async getPathRelation(pathId: string): Promise<PathRelation | null> {
    const record = this.storage.findPathRelationRecordById(pathId);
    return record === null ? null : validatePathRelation(record.payload as unknown as PathRelation);
  }

  public async listPathRelations(workspaceId: string): Promise<readonly PathRelation[]> {
    return this.storage
      .listPathRelationRecords(workspaceId)
      .map((record) => validatePathRelation(record.payload as unknown as PathRelation));
  }

  public async listActivePathRelations(workspaceId: string): Promise<readonly PathRelation[]> {
    return this.storage
      .listActivePathRelationRecords(workspaceId)
      .map((record) => validatePathRelation(record.payload as unknown as PathRelation));
  }

  public async listPathRelationsByAnchor(
    workspaceId: string,
    anchor: PathAnchorRef
  ): Promise<readonly PathRelation[]> {
    return this.storage
      .listPathRelationRecordsByAnchor(workspaceId, serializePathAnchorRef(anchor))
      .map((record) => validatePathRelation(record.payload as unknown as PathRelation));
  }

  public async projectTopology(workspaceId: string): Promise<TopologyProjection> {
    return projectReadOnlyTopology(await this.listActivePathRelations(workspaceId));
  }

  public async resolveManifestations(
    input: AuditedManifestationResolveInput
  ): Promise<AuditedMutationResult<readonly ManifestationDecision[]>> {
    return await executeWithAuditLog(
      this.storage,
      buildAuditInput("structure.manifestation.resolve", input, {
        type: "manifestation_decision_batch",
        id: input.runId
      }),
      () => resolveManifestations(input)
    );
  }

  public async decidePromotion(
    input: AuditedPromotionDecisionInput
  ): Promise<AuditedMutationResult<PromotionDecision>> {
    return await executeWithAuditLog(
      this.storage,
      buildAuditInput("governance.promotion.decide", input, {
        type: "promotion_candidate",
        id: input.candidate.target_id
      }, {
        candidate: input.candidate as unknown as JsonObject,
        gate: input.gate as unknown as JsonObject
      }),
      () => {
        this.assertUsableEvidenceRefs(input.candidate.evidence_refs);
        this.assertUsableSourceRefs(input.candidate.source_refs);
        const decision = evaluatePromotionGate(input.candidate, input.gate);
        this.storage.createGovernanceRecord({
          governanceEventId: randomUUID(),
          workspaceId: inferWorkspaceFromTarget(input.candidate.target_id),
          targetType: "promotion_candidate",
          targetId: input.candidate.target_id,
          outcome: decision.outcome,
          reason: decision.reason,
          payload: {
            decision: decision as unknown as JsonObject,
            candidate: input.candidate as unknown as JsonObject,
            governance_receipt: nullableJsonObject(input.candidate.governance_receipt)
          },
          createdAt: new Date().toISOString()
        });
        return decision;
      }
    );
  }

  public async evaluateGovernanceAction(
    input: AuditedGovernanceActionInput
  ): Promise<AuditedMutationResult<GovernancePolicyDecision>> {
    return await executeWithAuditLog(
      this.storage,
      buildAuditInput("governance.action.evaluate", input, {
        type: "governance_action",
        id: input.request.action_class
      }, {
        workspace_id: input.workspaceId,
        request: input.request as unknown as JsonObject
      }),
      () => {
        this.assertUsableEvidenceRefs(input.request.evidence_refs);
        this.assertUsableSourceRefs(input.request.source_refs);
        const decision = evaluateGovernanceAction(input.request);
        this.storage.createGovernanceRecord({
          governanceEventId: randomUUID(),
          workspaceId: input.workspaceId,
          targetType: "governance_action",
          targetId: input.request.action_class,
          outcome: decision.outcome,
          reason: decision.reason,
          payload: {
            decision: decision as unknown as JsonObject,
            request: input.request as unknown as JsonObject,
            governance_receipt: nullableJsonObject(input.request.governance_receipt),
            operator_reason: input.request.operator_reason ?? null
          },
          createdAt: new Date().toISOString()
        });
        return decision;
      }
    );
  }

  public async recordMemoryVisibility(
    input: AuditedMemoryVisibilityInput
  ): Promise<AuditedMutationResult<AuditedMemoryVisibilityInput["decision"]>> {
    return await executeWithAuditLog(
      this.storage,
      buildAuditInput("governance.memory_visibility.record", input, {
        type: "memory_visibility",
        id: input.decision.object_id
      }, {
        decision: input.decision as unknown as JsonObject
      }),
      () => {
        const memoryRecord = this.storage.findOntologyRecord("memory_entry", input.decision.object_id);
        if (memoryRecord === null) {
          throw new Error(`Ontology reference not found: memory_entry:${input.decision.object_id}`);
        }
        if (memoryRecord.workspaceId !== input.decision.workspace_id) {
          throw new Error(`Memory visibility workspace mismatch for ${input.decision.object_id}.`);
        }
        this.assertUsableEvidenceRefsInWorkspace(input.decision.evidence_refs, input.decision.workspace_id);
        this.assertUsableSourceRefsInWorkspace(input.decision.source_refs, input.decision.workspace_id);
        if (input.decision.state !== "visible" && input.decision.reason.trim().length === 0) {
          throw new Error("Memory visibility restriction requires a reason.");
        }
        this.storage.createGovernanceRecord({
          governanceEventId: randomUUID(),
          workspaceId: input.decision.workspace_id,
          targetType: "memory_visibility",
          targetId: input.decision.object_id,
          outcome: input.decision.state,
          reason: input.decision.reason,
          payload: input.decision as unknown as JsonObject,
          createdAt: input.decision.decided_at
        });
        return input.decision;
      }
    );
  }

  public async recordGovernanceBypass(
    input: AuditedGovernanceBypassInput
  ): Promise<AuditedMutationResult<GovernanceBypassSignal>> {
    return await executeWithAuditLog(
      this.storage,
      buildAuditInput("governance.bypass.detected", input, {
        type: "governance_bypass",
        id: input.attemptedMutation
      }),
      () => {
        const signal = detectGovernanceBypass({
          attempted_mutation: input.attemptedMutation,
          actor: input.actorRef,
          ...(input.recoverable === undefined ? {} : { recoverable: input.recoverable })
        });
        this.storage.createGovernanceRecord({
          governanceEventId: randomUUID(),
          workspaceId: input.workspaceId,
          targetType: "governance_bypass",
          targetId: input.attemptedMutation,
          outcome: signal.outcome,
          reason: signal.reason,
          payload: signal as unknown as JsonObject,
          createdAt: new Date().toISOString()
        });
        return signal;
      }
    );
  }

  public async assembleRecallContext(
    input: AuditedRecallContextInput
  ): Promise<AuditedMutationResult<ContextPack>> {
    const packId = input.packId ?? randomUUID();
    return await executeWithAuditLog(
      this.storage,
      buildAuditInput("recall.context.assemble", input, {
        type: "context_pack",
        id: packId
      }, {
        query: input.query as unknown as JsonObject,
        embedding: nullableJsonObject(input.embedding ?? null),
        budget: input.budget as unknown as JsonObject
      }),
      () => {
        const suppliedRecords = input.memoryRecords === undefined
          ? []
          : this.applyPersistedRecallGovernance(input.query.workspace_id, input.memoryRecords);
        const lexicalRecords = input.memoryRecords === undefined
          ? this.listRecallMemoryRecordsForSearch(input.query)
          : mergeRecallMemoryRecords(this.listRecallMemoryRecordsForSearch(input.query), suppliedRecords);
        const memoryRecords = input.memoryRecords === undefined
          ? this.listRecallMemoryRecords(input.query.workspace_id)
          : mergeRecallMemoryRecords(this.listRecallMemoryRecords(input.query.workspace_id), suppliedRecords);
        const lexical = rankLexicalRecallCandidates({
          query: input.query,
          records: lexicalRecords
        });
        const path = mergePathRecallContributions({
          query: input.query,
          baseline: lexical.candidates,
          records: memoryRecords,
          path_relations: this.storage
            .listActivePathRelationRecords(input.query.workspace_id)
            .map((record) => validatePathRelation(record.payload as unknown as PathRelation)),
          activation_candidates: input.activationCandidates ?? []
        });
        const embedding = applyEmbeddingSupplement({
          baseline: path.candidates,
          records: memoryRecords,
          embedding: input.embedding ?? {
            enabled: false,
            provider_state: "disabled",
            max_supplement: 0
          },
          supplement: input.embeddingSupplement ?? [],
          query: input.query
        });
        return this.createContextPackRecord(
          input,
          input.query.query_text,
          input.query.run_id ?? inferRunIdFromAudit(input),
          assembleContextPack({
          pack_id: packId,
          query: input.query,
          candidates: embedding.candidates,
          exclusions: [
            ...lexical.exclusions,
            ...path.exclusions,
            ...embedding.exclusions
          ],
          degradations: [
            ...lexical.degradations,
            ...path.degradations,
            ...embedding.degradations
          ],
          budget: input.budget
          })
        );
      }
    );
  }

  public async recordContextPack(
    input: AuditedContextPackInput
  ): Promise<AuditedMutationResult<ContextPack>> {
    return await executeWithAuditLog(
      this.storage,
      buildAuditInput("recall.context_pack.record", input, {
        type: "context_pack",
        id: input.input.pack_id
      }, {
        query: input.input.query as unknown as JsonObject,
        budget: input.input.budget as unknown as JsonObject
      }),
      () => this.createContextPackRecord(
        input,
        input.input.query.query_text,
        input.input.query.run_id ?? inferRunIdFromAudit(input),
        assembleContextPack(input.input)
      )
    );
  }

  public async selectProvider(
    input: AuditedProviderSelectionInput
  ): Promise<AuditedMutationResult<ProviderSelectionResult>> {
    const request = withRuntimeProviderDecisionId(input.workspaceId, input.request);
    return await executeWithAuditLog(
      this.storage,
      buildAuditInput("provider.selection.decide", input, {
        type: "provider_selection",
        id: request.decision_id ?? `${input.workspaceId}:${request.capability}`
      }, {
        workspace_id: input.workspaceId,
        request: request as unknown as JsonObject
      }),
      () => {
        const result = selectProviderForCapability(input.providers, request);
        const existing = this.storage.findProviderDecisionRecord(result.decision_id, input.workspaceId);
        const replayScope = createProviderDecisionReplayScope(input.providers, request);
        if (existing !== null) {
          const existingReplayScope = this.storage.findProviderDecisionReplayScope(result.decision_id, input.workspaceId);
          assertProviderDecisionReplayMatches(existing, existingReplayScope, replayScope, result);
          return result;
        }
        this.storage.createProviderDecisionRecord({
          decisionId: result.decision_id,
          workspaceId: input.workspaceId,
          capability: result.capability,
          selectedProviderId: result.selected_provider?.provider_id ?? null,
          outcome: result.status,
          reason: result.selection_reason,
          payload: {
            result: result as unknown as JsonObject,
            replay_scope: {
              providers_fingerprint: replayScope.providersFingerprint,
              request_fingerprint: replayScope.requestFingerprint
            }
          },
          createdAt: new Date().toISOString()
        });
        return result;
      }
    );
  }

  public async recordProposal(
    input: AuditedProposalRecordInput
  ): Promise<AuditedMutationResult<ProposalValidationResult>> {
    return await executeWithAuditLog(
      this.storage,
      buildAuditInput("provider.proposal.record", input, {
        type: "proposal",
        id: input.proposal.proposal_id
      }, {
        workspace_id: input.workspaceId,
        proposal: input.proposal as unknown as JsonObject
      }),
      () => {
        const result = this.validateProposalForRuntimeEnvelope(input);
        const proposalReplayFingerprint = replayFingerprint(result);
        const comparableResult = redactJsonObject(result) as unknown as ProposalValidationResult;
        const existing = this.storage.findProposalRecord(result.proposal.proposal_id, input.workspaceId);
        if (existing !== null) {
          assertProposalReplayMatches(existing, proposalReplayFingerprint, result);
          return result;
        }
        this.storage.createProposalRecord({
          proposalId: result.proposal.proposal_id,
          workspaceId: input.workspaceId,
          providerDecisionId: result.proposal.provider_decision_id,
          runId: result.proposal.scope?.run_id ?? null,
          status: result.proposal.lifecycle_state,
          targetId: result.proposal.proposed_content_ref,
          payload: comparableResult as unknown as JsonObject,
          replayFingerprint: proposalReplayFingerprint,
          createdAt: result.proposal.created_at
        });
        return result;
      }
    );
  }

  public async recordMemorySessionEvent(
    input: AuditedMemorySessionEventInput
  ): Promise<AuditedMutationResult<MemorySessionEvent>> {
    return await executeWithAuditLog(
      this.storage,
      buildAuditInput("session.event.record", input, {
        type: "memory_session_event",
        id: input.event.event_id
      }, {
        event_type: input.event.type,
        session_id: input.event.session_id,
        run_id: input.event.run_id
      }),
      () => {
        this.assertSessionEventLineage(input.event);
        const existingById = this.storage.findSessionEventRecordById(input.event.event_id);
        const existingEvents = this.storage
          .listSessionEventRecords(input.event.session_id, {
            workspaceId: input.event.workspace_id,
            runId: input.event.run_id
          })
          .map((record) => record.payload as unknown as MemorySessionEvent);
        const replayInput = existingById === null || existingEvents.some((event) => event.event_id === existingById.eventId)
          ? existingEvents
          : [existingById.payload as unknown as MemorySessionEvent, ...existingEvents];
        const replayed = recordSessionEvent(replayInput, input.event);
        if (replayed.length === existingEvents.length) {
          return input.event;
        }
        const event = replayed[replayed.length - 1] ?? input.event;
        this.storage.createSessionEventRecord({
          eventId: event.event_id,
          sessionId: event.session_id,
          workspaceId: event.workspace_id,
          runId: event.run_id,
          eventKind: event.type,
          terminal: event.type === "terminal_event",
          payload: event as unknown as JsonObject,
          occurredAt: event.recorded_at
        });
        if (event.type === "context_delivered") {
          const delivery = validateContextDeliveryRecord(event.delivery);
          this.storage.createContextDeliveryRecord({
            deliveryId: delivery.delivery_id,
            sessionId: delivery.session_id,
            workspaceId: delivery.workspace_id,
            runId: delivery.run_id,
            contextPackId: delivery.context_pack_id,
            outcome: delivery.outcome,
            payload: delivery as unknown as JsonObject,
            deliveredAt: delivery.delivered_at
          });
        }
        if (event.type === "usage_proof_recorded") {
          const proof = validateUsageProofRecord(event.usage_proof);
          this.storage.createUsageProofRecord({
            proofId: proof.proof_id,
            sessionId: proof.session_id,
            workspaceId: proof.workspace_id,
            runId: proof.run_id,
            proofKind: proof.proof_strength,
            strength: proof.proof_strength,
            payload: proof as unknown as JsonObject,
            observedAt: proof.observed_at
          });
        }
        return event;
      }
    );
  }

  public async generateTrustSummary(
    input: AuditedTrustSummaryInput
  ): Promise<AuditedMutationResult<TrustSummary>> {
    return await executeWithAuditLog(
      this.storage,
      buildAuditInput("session.trust_summary.generate", input, {
        type: "trust_summary",
        id: input.summaryId
      }, {
        session_id: input.sessionId,
        run_id: input.runId,
        workspace_id: input.workspaceId
      }),
      () => {
        const events = this.storage
          .listSessionEventRecords(input.sessionId, {
            workspaceId: input.workspaceId,
            runId: input.runId
          })
          .map((record) => record.payload as unknown as MemorySessionEvent);
        if (events.length === 0) {
          throw new Error(`Session events not found for ${input.workspaceId}:${input.runId}:${input.sessionId}.`);
        }
        events.forEach((event) => this.assertSessionEventLineage(event));
        const summary = deriveTrustSummary(events);
        assertTrustSummaryIdentity(summary, input);
        const summaryReplayFingerprint = replayFingerprint(summary);
        const existing = this.storage.findTrustSummaryRecord(input.summaryId, input.workspaceId);
        if (existing !== null) {
          assertTrustSummaryReplayMatches(existing, input, summaryReplayFingerprint, summary);
          return summary;
        }
        this.storage.createTrustSummaryRecord({
          summaryId: input.summaryId,
          sessionId: input.sessionId,
          workspaceId: input.workspaceId,
          runId: input.runId,
          trustState: summary.state,
          payload: summary as unknown as JsonObject,
          replayFingerprint: summaryReplayFingerprint,
          generatedAt: input.generatedAt
        });
        return summary;
      }
    );
  }

  public async doctor(): Promise<DoctorReport> {
    return createDoctorReport(this.storage.getDoctorSnapshot());
  }

  public async close(): Promise<void> {
    this.storage.close();
  }

  private async createOntologyRecord<T extends OntologyRecord>(
    input: AuditedOntologyWriteInput<T>,
    kind: string,
    validate: (record: T) => T
  ): Promise<AuditedMutationResult<T>> {
    return await executeWithAuditLog(
      this.storage,
      buildAuditInput(kind, input, {
        type: input.record.object_kind,
        id: input.record.object_id
      }),
      () => {
        const record = validate(input.record);
        const inserted = this.storage.createOntologyRecord({
          objectKind: record.object_kind,
          objectId: record.object_id,
          workspaceId: record.workspace_id,
          lifecycleState: record.lifecycle_state,
          evidenceHealthState: record.object_kind === "evidence_capsule" ? record.evidence_health_state : null,
          payload: record as unknown as JsonObject,
          createdAt: record.created_at,
          updatedAt: record.updated_at
        });
        return validateOntologyRecord(inserted.payload as unknown as OntologyRecord) as T;
      }
    );
  }

  private assertUsableEvidenceRefs(evidenceRefs: readonly string[]): void {
    for (const evidenceRef of evidenceRefs) {
      const record = this.storage.findOntologyRecord("evidence_capsule", evidenceRef);
      if (record === null) {
        throw new Error(`Evidence reference not found: ${evidenceRef}`);
      }
      assertEvidenceCanSupportDurableWrite(record.payload as unknown as EvidenceCapsule);
    }
  }

  private assertOntologyRecordExists(kind: OntologyRecord["object_kind"], objectId: string): void {
    if (this.storage.findOntologyRecord(kind, objectId) === null) {
      throw new Error(`Ontology reference not found: ${kind}:${objectId}`);
    }
  }

  private assertUsableEvidenceRefsInWorkspace(evidenceRefs: readonly string[], workspaceId: string): void {
    for (const evidenceRef of evidenceRefs) {
      const record = this.storage.findOntologyRecord("evidence_capsule", evidenceRef);
      if (record === null) {
        throw new Error(`Evidence reference not found: ${evidenceRef}`);
      }
      if (record.workspaceId !== workspaceId) {
        throw new Error(`Evidence reference workspace mismatch: ${evidenceRef}`);
      }
      assertEvidenceCanSupportDurableWrite(record.payload as unknown as EvidenceCapsule);
    }
  }

  private assertUsableSourceRefsInWorkspace(sourceRefs: readonly string[], workspaceId: string): void {
    for (const sourceRef of sourceRefs) {
      this.assertAnyOntologyRecordExistsInWorkspace(sourceRef, workspaceId);
    }
  }

  private assertAnyOntologyRecordExists(objectId: string): void {
    for (const kind of ["evidence_capsule", "memory_entry", "synthesis_capsule", "claim_form"] as const) {
      if (this.storage.findOntologyRecord(kind, objectId) !== null) {
        return;
      }
    }
    throw new Error(`Ontology reference not found: ${objectId}`);
  }

  private assertAnyOntologyRecordExistsInWorkspace(objectId: string, workspaceId: string): void {
    for (const kind of ["evidence_capsule", "memory_entry", "synthesis_capsule", "claim_form"] as const) {
      const record = this.storage.findOntologyRecord(kind, objectId);
      if (record !== null) {
        if (record.workspaceId !== workspaceId) {
          throw new Error(`Source reference workspace mismatch: ${objectId}`);
        }
        return;
      }
    }
    throw new Error(`Ontology reference not found: ${objectId}`);
  }

  private assertUsableSourceRefs(sourceRefs: readonly string[]): void {
    for (const sourceRef of sourceRefs) {
      this.assertAnyOntologyRecordExists(sourceRef);
    }
  }

  private assertPathAnchorsResolve(relation: PathRelation): void {
    for (const anchor of [relation.anchors.source_anchor, relation.anchors.target_anchor]) {
      switch (anchor.kind) {
        case "object":
        case "object_facet":
          this.assertAnyOntologyRecordExists(anchor.object_id);
          break;
        case "obligation":
        case "risk_concern":
        case "time_concern":
          this.assertAnyOntologyRecordExists(anchor.source_object_id);
          break;
      }
    }
  }

  private assertPathGovernanceAllowsDurableWrite(
    relation: PathRelation,
    governanceReceipt: { readonly approved: boolean; readonly actor: string; readonly reason: string; readonly decided_at: string } | null
  ): void {
    if (relation.legitimacy.governance_class !== "strictly_governed") {
      return;
    }
    if (governanceReceipt?.approved !== true) {
      throw new Error(`Path relation ${relation.path_id} requires governance approval.`);
    }
  }

  private validateProposalForRuntimeEnvelope(
    input: AuditedProposalRecordInput
  ): ProposalValidationResult {
    const result = validateProposalRecord(input.proposal);
    const runtimeReasons: string[] = [];

    if (result.proposal.scope !== null && result.proposal.scope.workspace_id !== input.workspaceId) {
      runtimeReasons.push("scope_workspace_mismatch");
    }

    if (result.proposal.provider_decision_id === null) {
      if (result.proposal.source?.kind !== "operator") {
        runtimeReasons.push("provider_decision_missing");
      }
    } else {
      const decision = this.storage.findProviderDecisionRecord(result.proposal.provider_decision_id, input.workspaceId);
      if (decision === null) {
        runtimeReasons.push("provider_decision_missing");
      } else {
        if (decision.capability !== "proposal") {
          runtimeReasons.push("provider_decision_capability_mismatch");
        }
        if (
          result.proposal.source?.kind === "provider" &&
          (decision.selectedProviderId ?? null) !== result.proposal.source.ref
        ) {
          runtimeReasons.push("provider_decision_source_mismatch");
        }
      }
    }

    if (runtimeReasons.length === 0) {
      return result;
    }

    const rejected = validateProposalRecord(createRejectedProposalRecord(
      result.proposal,
      runtimeReasons.join(";")
    ));
    return {
      ...rejected,
      reasons: uniqueReasonValues([
        ...result.reasons,
        ...runtimeReasons
      ])
    };
  }

  private listRecallMemoryRecords(
    workspaceId: string,
    objectIds?: readonly string[]
  ): readonly RecallMemoryRecord[] {
    const records = objectIds === undefined
      ? this.storage.listOntologyRecords("memory_entry", workspaceId)
      : objectIds.flatMap((objectId) => {
        const record = this.storage.findOntologyRecord("memory_entry", objectId);
        return record === null || record.workspaceId !== workspaceId ? [] : [record];
      });

    return records.map((record) => ({
      memory: validateMemoryEntry(record.payload as unknown as MemoryEntry),
      governance_state: this.governanceStateForMemory(workspaceId, record.objectId)
    }));
  }

  private applyPersistedRecallGovernance(
    workspaceId: string,
    records: readonly RecallMemoryRecord[]
  ): readonly RecallMemoryRecord[] {
    return records.flatMap((record) => {
      const memory = validateMemoryEntry(record.memory);
      const persisted = this.storage.findOntologyRecord("memory_entry", memory.object_id);
      if (persisted === null || persisted.workspaceId !== workspaceId) {
        return [];
      }
      return {
        memory: validateMemoryEntry(persisted.payload as unknown as MemoryEntry),
        governance_state: this.governanceStateForMemory(workspaceId, memory.object_id)
      };
    });
  }

  private listRecallMemoryRecordsForSearch(query: AuditedRecallContextInput["query"]): readonly RecallMemoryRecord[] {
    const searchLimit = Math.max(query.limit * 4, query.limit, 20);
    const searchHits = this.storage.searchMemoryContent(query.workspace_id, query.query_text, searchLimit);
    return this.listRecallMemoryRecords(
      query.workspace_id,
      searchHits.map((record) => record.objectId)
    );
  }

  private governanceStateForMemory(workspaceId: string, objectId: string): RecallGovernanceState {
    const governance = this.storage.findLatestGovernanceRecordForTarget(workspaceId, objectId, "memory_visibility")
      ?? this.storage.findLatestGovernanceRecordForTarget(workspaceId, objectId, "promotion_candidate");
    if (governance === null) {
      return "visible";
    }
    if (governance.targetType === "memory_visibility") {
      return governanceVisibilityState(governance.outcome, governance.reason);
    }
    if (governance.targetType === "promotion_candidate") {
      if (governance.outcome === "pending_review") {
        return "blocked";
      }
      if (governance.outcome === "not_promoted") {
        return "hidden";
      }
    }
    return "visible";
  }

  private createContextPackRecord(
    input: Pick<AuditedMutationInput, "source" | "evidence">,
    queryText: string,
    runId: string,
    contextPack: ContextPack
  ): ContextPack {
    const contextPackReplayFingerprint = replayFingerprint(contextPack);
    const existing = this.storage.findContextPackRecord(contextPack.pack_id, contextPack.workspace_id);
    if (existing !== null) {
      assertContextPackReplayMatches(existing, runId, queryText, contextPackReplayFingerprint, contextPack);
      return contextPack;
    }
    this.storage.createContextPackRecord({
      contextPackId: contextPack.pack_id,
      workspaceId: contextPack.workspace_id,
      runId,
      queryText,
      includedMemoryIds: contextPack.included.map((entry) => entry.candidate.object_id),
      payload: contextPack as unknown as JsonObject,
      replayFingerprint: contextPackReplayFingerprint,
      createdAt: new Date().toISOString()
    });
    return contextPack;
  }

  private assertSessionEventLineage(event: MemorySessionEvent): void {
    switch (event.type) {
      case "context_delivered": {
        const delivery = validateContextDeliveryRecord(event.delivery);
        this.assertContextPackLineage(
          delivery.context_pack_id,
          delivery.workspace_id,
          delivery.run_id,
          delivery.memory_ids,
          "delivery",
          delivery.outcome === "delivered"
        );
        break;
      }
      case "usage_proof_recorded": {
        const proof = validateUsageProofRecord(event.usage_proof);
        this.assertContextPackLineage(
          proof.context_pack_id,
          proof.workspace_id,
          proof.run_id,
          proof.memory_ids,
          "usage proof",
          false
        );
        break;
      }
      case "proposal_recorded":
        this.assertProposalSessionLineage(event.proposal_id, event.workspace_id, event.run_id);
        break;
      default:
        break;
    }
  }

  private assertContextPackLineage(
    contextPackId: string,
    workspaceId: string,
    runId: string,
    memoryIds: readonly string[],
    label: string,
    requireExactMemorySet: boolean
  ): void {
    const record = this.storage.findContextPackRecord(contextPackId, workspaceId);
    if (record === null) {
      throw new Error(`Context pack not found for ${label}: ${contextPackId}.`);
    }
    if (record.runId !== runId) {
      throw new Error(`Context pack run mismatch for ${label}: ${contextPackId}.`);
    }
    const included = new Set(record.includedMemoryIds);
    const missing = memoryIds.filter((memoryId) => !included.has(memoryId));
    if (missing.length > 0) {
      throw new Error(`Context pack memory mismatch for ${label}: ${missing.join(",")}.`);
    }
    if (requireExactMemorySet) {
      const supplied = new Set(memoryIds);
      const unreported = record.includedMemoryIds.filter((memoryId) => !supplied.has(memoryId));
      if (unreported.length > 0) {
        throw new Error(`Context pack memory mismatch for ${label}: ${unreported.join(",")}.`);
      }
    }
  }

  private assertProposalSessionLineage(proposalId: string, workspaceId: string, runId: string): void {
    const proposal = this.storage.findProposalRecord(proposalId, workspaceId);
    if (proposal === null) {
      throw new Error(`Proposal record not found for session event: ${proposalId}.`);
    }
    if ((proposal.runId ?? null) !== runId) {
      throw new Error(`Proposal record run mismatch for session event: ${proposalId}.`);
    }
  }
}

function assertRuntimeDecisionKind(kind: string): void {
  if (!kind.startsWith("runtime.")) {
    throw new InvalidRuntimeDecisionKindError(kind);
  }
}

function buildAuditInput(
  kind: string,
  input: Omit<AuditedMutationInput, "kind" | "target" | "payload">,
  target: AuditedMutationInput["target"],
  payload?: JsonObject
): AuditedMutationInput {
  return {
    kind,
    source: input.source,
    evidence: input.evidence,
    ...(input.actor === undefined ? {} : { actor: input.actor }),
    ...(target === undefined ? {} : { target }),
    ...(payload === undefined ? {} : { payload })
  };
}

function inferWorkspaceFromTarget(targetId: string): string {
  const [workspaceId] = targetId.split(":");
  return workspaceId?.trim() ? workspaceId : "governance";
}

function nullableJsonObject(value: unknown): JsonObject | null {
  return value === undefined || value === null ? null : value as JsonObject;
}

function withRuntimeProviderDecisionId(
  workspaceId: string,
  request: ProviderSelectionRequest
): ProviderSelectionRequest {
  const supplied = request.decision_id?.trim();
  if (supplied !== undefined && supplied.length > 0) {
    return {
      ...request,
      decision_id: [
        "provider-selection",
        workspaceId,
        "custom",
        supplied
      ].join(":")
    };
  }
  return {
    ...request,
    decision_id: [
      "provider-selection",
      workspaceId,
      request.capability,
      request.required ? "required" : "optional",
      request.scope_ref ?? "global"
    ].join(":")
  };
}

function assertProviderDecisionReplayMatches(
  existing: {
    readonly capability: string;
    readonly selectedProviderId?: string | null;
    readonly outcome: string;
    readonly reason: string;
  },
  existingReplayScope: {
    readonly requestFingerprint: string;
    readonly providersFingerprint: string;
  } | null,
  replayScope: {
    readonly requestFingerprint: string;
    readonly providersFingerprint: string;
  },
  result: ProviderSelectionResult
): void {
  if (
    existingReplayScope === null ||
    existingReplayScope.requestFingerprint !== replayScope.requestFingerprint ||
    existingReplayScope.providersFingerprint !== replayScope.providersFingerprint ||
    existing.capability !== result.capability ||
    (existing.selectedProviderId ?? null) !== (result.selected_provider?.provider_id ?? null) ||
    existing.outcome !== result.status ||
    existing.reason !== result.selection_reason
  ) {
    throw new Error(`Provider decision replay conflict: ${result.decision_id}.`);
  }
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`);
  return `{${entries.join(",")}}`;
}

function canonicalProviderRegistry(providers: readonly ProviderRegistryEntry[]): readonly ProviderRegistryEntry[] {
  return [...providers].sort((left, right) => providerFingerprintKey(left).localeCompare(providerFingerprintKey(right)));
}

function createProviderDecisionReplayScope(
  providers: readonly ProviderRegistryEntry[],
  request: ProviderSelectionRequest
): {
  readonly requestFingerprint: string;
  readonly providersFingerprint: string;
} {
  return {
    providersFingerprint: replayFingerprint(canonicalProviderRegistry(providers)),
    requestFingerprint: replayFingerprint(request)
  };
}

function replayFingerprint(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function mergeRecallMemoryRecords(
  base: readonly RecallMemoryRecord[],
  hints: readonly RecallMemoryRecord[]
): readonly RecallMemoryRecord[] {
  const merged = new Map<string, RecallMemoryRecord>();
  for (const record of base) {
    merged.set(record.memory.object_id, record);
  }
  for (const record of hints) {
    if (!merged.has(record.memory.object_id)) {
      merged.set(record.memory.object_id, record);
    }
  }
  return [...merged.values()];
}

function uniqueReasonValues(values: readonly string[]): readonly string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    output.push(value);
  }
  return output;
}

function providerFingerprintKey(provider: ProviderRegistryEntry): string {
  return [
    provider.provider_id,
    provider.provider_kind,
    provider.model_ref,
    provider.config_ref
  ].join("|");
}

function assertProposalReplayMatches(
  existing: {
    readonly providerDecisionId?: string | null;
    readonly replayFingerprint: string;
    readonly status: string;
    readonly targetId?: string | null;
  },
  proposalReplayFingerprint: string,
  result: ProposalValidationResult
): void {
  if (
    (existing.providerDecisionId ?? null) !== result.proposal.provider_decision_id ||
    existing.replayFingerprint !== proposalReplayFingerprint ||
    existing.status !== result.proposal.lifecycle_state ||
    (existing.targetId ?? null) !== result.proposal.proposed_content_ref
  ) {
    throw new Error(`Proposal replay conflict: ${result.proposal.proposal_id}.`);
  }
}

function assertContextPackReplayMatches(
  existing: {
    readonly contextPackId: string;
    readonly includedMemoryIds: readonly string[];
    readonly queryText: string;
    readonly replayFingerprint: string;
    readonly runId: string;
  },
  runId: string,
  queryText: string,
  contextPackReplayFingerprint: string,
  contextPack: ContextPack
): void {
  if (
    existing.runId !== runId ||
    existing.queryText !== queryText ||
    existing.replayFingerprint !== contextPackReplayFingerprint ||
    stableJson(existing.includedMemoryIds) !== stableJson(contextPack.included.map((entry) => entry.candidate.object_id))
  ) {
    throw new Error(`Context pack replay conflict: ${existing.contextPackId}.`);
  }
}

function assertTrustSummaryIdentity(summary: TrustSummary, input: AuditedTrustSummaryInput): void {
  if (
    summary.session_id !== input.sessionId ||
    summary.workspace_id !== input.workspaceId ||
    summary.run_id !== input.runId
  ) {
    throw new Error(`Trust summary identity mismatch for ${input.workspaceId}:${input.runId}:${input.sessionId}.`);
  }
}

function assertTrustSummaryReplayMatches(
  existing: {
    readonly runId: string;
    readonly sessionId: string;
    readonly trustState: string;
    readonly replayFingerprint: string;
  },
  input: AuditedTrustSummaryInput,
  summaryReplayFingerprint: string,
  summary: TrustSummary
): void {
  if (
    existing.sessionId !== input.sessionId ||
    existing.runId !== input.runId ||
    existing.trustState !== summary.state ||
    existing.replayFingerprint !== summaryReplayFingerprint
  ) {
    throw new Error(`Trust summary replay conflict: ${input.summaryId}.`);
  }
}

function governanceVisibilityState(outcome: string, reason: string): RecallGovernanceState {
  const normalized = `${outcome} ${reason}`.toLocaleLowerCase("en-US");
  if (normalized.includes("hidden")) {
    return "hidden";
  }
  if (
    normalized.includes("blocked") ||
    outcome === "pending_review" ||
    outcome === "not_promoted"
  ) {
    return "blocked";
  }
  return "visible";
}

function inferRunIdFromAudit(input: Pick<AuditedMutationInput, "source" | "evidence">): string {
  const sourceRunId = readRunId(input.source);
  if (typeof sourceRunId === "string" && sourceRunId.trim().length > 0) {
    return sourceRunId;
  }
  for (const evidence of input.evidence) {
    const evidenceRunId = readRunId(evidence);
    if (typeof evidenceRunId === "string" && evidenceRunId.trim().length > 0) {
      return evidenceRunId;
    }
  }
  return "runtime";
}

function readRunId(value: unknown): string | null {
  const direct = (value as { readonly run_id?: unknown }).run_id;
  if (typeof direct === "string" && direct.trim().length > 0) {
    return direct;
  }
  const metadata = (value as { readonly metadata?: unknown }).metadata;
  if (metadata !== null && typeof metadata === "object") {
    const nested = (metadata as { readonly run_id?: unknown }).run_id;
    if (typeof nested === "string" && nested.trim().length > 0) {
      return nested;
    }
  }
  return null;
}
