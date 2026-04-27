import { randomUUID } from "node:crypto";
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
  AuditedGovernanceActionInput,
  AuditedGovernanceBypassInput,
  AuditedManifestationResolveInput,
  AuditedOntologyWriteInput,
  AuditedPathRelationWriteInput,
  AuditedPromotionDecisionInput,
  AuditedRuntimeDecisionInput,
  AuditedRuntimeDecisionReceipt
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
import type { JsonObject } from "./json.js";

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

  private assertAnyOntologyRecordExists(objectId: string): void {
    for (const kind of ["evidence_capsule", "memory_entry", "synthesis_capsule", "claim_form"] as const) {
      if (this.storage.findOntologyRecord(kind, objectId) !== null) {
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
