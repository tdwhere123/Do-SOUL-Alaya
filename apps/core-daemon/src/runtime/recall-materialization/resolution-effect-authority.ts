import type {
  ClaimForm,
  ContextDeliveryRecord,
  EffectRequest,
  FieldContractSha256,
  MemoryEntry,
  ProofEffectWitness
} from "@do-soul/alaya-protocol";
import {
  EffectRequestSchema,
  PROOF_EFFECT_OPERATOR_ID,
  PROOF_EFFECT_OPERATOR_VERSION,
  canonicalEffectClaimFact,
  canonicalEffectMemoryFact,
  hashCorrectionPredecessorId,
  hashCorrectionSuccessorId,
  hashEffectDecisionFactSnapshot,
  hashEffectGovernanceFrontier,
  hashContentDigest
} from "@do-soul/alaya-protocol";
import {
  ProofCarryingEffectOwner,
  fieldContractSha256,
  type CompetingClaim,
  type ProofEffectLookup,
  type ProofRecord,
  type ResolutionDeliveryAuthorityPort,
  type ResolutionEffectAuthorityPort
} from "@do-soul/alaya-core";
import type { StorageDatabase } from "@do-soul/alaya-storage";
import {
  matchesDeliveryContext,
  resolveDeliveredTargetSources
} from "../../mcp-memory/tool/resolution-delivery-scope.js";
import type { DaemonFieldComposition } from "../field/field-composition.js";

type EffectInput = Parameters<ResolutionEffectAuthorityPort["decide"]>[0];
type DeliveryInput = Parameters<ResolutionDeliveryAuthorityPort["authorize"]>[0];
type SourceRecord = ReturnType<
  DaemonFieldComposition["fieldRepos"]["records"]["listByWorkspace"]
>[number];

type AuthorityDependencies = Readonly<{
  database: StorageDatabase;
  fieldComposition: DaemonFieldComposition;
  claimRepo: {
    findById(objectId: string): Promise<Readonly<ClaimForm> | null>;
    findByCanonicalKey(
      workspaceId: string,
      canonicalKey: string
    ): Promise<readonly Readonly<ClaimForm>[]>;
  };
  memoryRepo: {
    findByIds(
      workspaceId: string,
      objectIds: readonly string[]
    ): Promise<readonly Readonly<MemoryEntry>[]>;
  };
  deliveryReader: {
    findDeliveryById(deliveryId: string): Promise<Readonly<ContextDeliveryRecord> | null>;
  };
  sha256?: FieldContractSha256;
}>;

export function createResolutionEffectAuthority(deps: AuthorityDependencies) {
  const authority = new ResolutionEffectAuthority(deps);
  return Object.freeze({ deliveryAuthority: authority, effectAuthority: authority });
}

class ResolutionEffectAuthority implements
  ResolutionDeliveryAuthorityPort,
  ResolutionEffectAuthorityPort {
  private readonly sha256: FieldContractSha256;

  public constructor(private readonly deps: AuthorityDependencies) {
    this.sha256 = deps.sha256 ?? fieldContractSha256;
  }

  public async authorize(input: DeliveryInput) {
    const scope = await this.loadDeliveredScope(input);
    return scope === null ? null : Object.freeze({ deliveredAt: scope.delivery.delivered_at });
  }

  public async decide(input: EffectInput) {
    const context = await this.loadDecisionContext(input);
    const proofs = context?.proofs ?? [];
    const witnesses = context?.witnesses ?? [];
    const request = this.buildRequest(input, witnesses);
    const lookup = createRequestLookup(request, proofs, context);
    return new ProofCarryingEffectOwner({
      lookup,
      sha256: this.sha256,
      now: () => input.effectiveAsOf
    }).decide(request);
  }

  private async loadDecisionContext(input: EffectInput) {
    const scope = await this.loadDeliveredScope(input);
    if (scope === null) return null;
    const claim = await this.deps.claimRepo.findById(input.targetObjectId);
    if (claim === null) return await this.loadMemoryDecisionContext(input, scope);
    if (claim.workspace_id !== input.workspaceId) return null;
    const evidence = await this.collectGroundedEvidence(input.workspaceId, claim, scope.sourceIds);
    const competing = await this.deps.claimRepo.findByCanonicalKey(
      input.workspaceId,
      claim.governance_subject.canonical_key
    );
    const competingFacts = competing.filter(isLiveClaim).map((candidate) =>
      claimFrontierFact(
        candidate,
        evidence.groundedEvidenceIds,
        claim.scope_class
      ));
    const targetFact = claimFrontierFact(claim, evidence.groundedEvidenceIds, claim.scope_class);
    const factSnapshotId = hashEffectDecisionFactSnapshot({
      target_fact: targetFact,
      competing_facts: competingFacts,
      erased: this.isSubjectErased(input.workspaceId, input.targetObjectId),
      bridge_revoked: false,
      delivery_authority_event_id: scope.delivery.audit_event_id
    }, this.sha256);
    const verified = this.buildVerifiedProofs(
      input,
      scope.delivery,
      claim,
      evidence.sourceRecords,
      targetFact,
      factSnapshotId
    );
    return Object.freeze({
      proofs: Object.freeze(verified.map((item) => item.proof)),
      witnesses: Object.freeze(verified.map((item) => item.witness)),
      targetTime: claimTime(claim, true, claim.scope_class),
      competing: Object.freeze(competing.filter(isLiveClaim).map((candidate) =>
        claimTime(candidate, candidate.evidence_refs.some((id) =>
          evidence.groundedEvidenceIds.has(id)), claim.scope_class))),
      erased: this.isSubjectErased(input.workspaceId, input.targetObjectId)
    });
  }

  private async loadMemoryDecisionContext(
    input: EffectInput,
    scope: Readonly<{ delivery: ContextDeliveryRecord; sourceIds: readonly string[] }>
  ) {
    if (input.action !== "correct" || input.correction === undefined) return null;
    const [memory] = await this.deps.memoryRepo.findByIds(input.workspaceId, [input.targetObjectId]);
    if (memory === undefined || memory.workspace_id !== input.workspaceId) return null;
    const evidence = this.collectEvidenceState(input.workspaceId, new Set(memory.evidence_refs));
    const targetFact = memoryFrontierFact(memory, this.sha256);
    const factSnapshotId = hashEffectDecisionFactSnapshot({
      target_fact: targetFact,
      competing_facts: [],
      erased: this.isSubjectErased(input.workspaceId, input.targetObjectId),
      bridge_revoked: false,
      delivery_authority_event_id: scope.delivery.audit_event_id
    }, this.sha256);
    const verified = this.buildMemoryCorrectionProofs(
      input,
      scope.delivery,
      memory,
      evidence.sourceRecords,
      targetFact,
      factSnapshotId
    );
    return Object.freeze({
      proofs: Object.freeze(verified.map((item) => item.proof)),
      witnesses: Object.freeze(verified.map((item) => item.witness)),
      targetTime: memoryTime(memory),
      competing: Object.freeze([]),
      erased: this.isSubjectErased(input.workspaceId, input.targetObjectId)
    });
  }

  private buildRequest(
    input: EffectInput,
    witnesses: readonly ProofEffectWitness[]
  ): EffectRequest {
    return EffectRequestSchema.parse({
      schema_version: 2,
      workspace_id: input.workspaceId,
      actor_id: input.actorId,
      run_id: input.runId,
      delivery_id: input.deliveryId,
      action: input.action,
      target: input.targetObjectId,
      scope: input.scope,
      effective_as_of: input.effectiveAsOf,
      supporting_receipt_ids: witnesses.map((witness) => witness.receipt_id),
      supporting_proof_witnesses: witnesses,
      governance_frontier: hashEffectGovernanceFrontier(witnesses, this.sha256),
      policy_operator_id: PROOF_EFFECT_OPERATOR_ID,
      policy_operator_version: PROOF_EFFECT_OPERATOR_VERSION
    });
  }

  private async loadDeliveredScope(input: DeliveryInput | EffectInput) {
    const delivery = await this.deps.deliveryReader.findDeliveryById(input.deliveryId);
    if (delivery === null || !matchesDeliveryContext(delivery, {
      workspaceId: input.workspaceId,
      agentTarget: input.actorId,
      runId: input.runId
    })) return null;
    const claim = await this.deps.claimRepo.findById(input.targetObjectId);
    const sourceRefs = claim?.workspace_id === input.workspaceId ? claim.source_object_refs : null;
    const sourceIds = resolveDeliveredTargetSources(delivery, input.targetObjectId, sourceRefs);
    return sourceIds === null ? null : Object.freeze({ delivery, sourceIds });
  }

  private async collectGroundedEvidence(
    workspaceId: string,
    claim: Readonly<ClaimForm>,
    deliveredSourceIds: readonly string[]
  ) {
    const memories = await this.deps.memoryRepo.findByIds(workspaceId, deliveredSourceIds);
    const deliveredEvidence = new Set(memories.flatMap((memory) => memory.evidence_refs));
    const eligibleEvidence = new Set(claim.evidence_refs.filter((id) => deliveredEvidence.has(id)));
    return this.collectEvidenceState(workspaceId, eligibleEvidence);
  }

  private collectEvidenceState(workspaceId: string, eligibleEvidence: ReadonlySet<string>) {
    const erased = this.listErasedSubjectKeys(workspaceId);
    const bindings = this.deps.fieldComposition.fieldRepos.records.listEvidenceBindings(workspaceId);
    const sourceRecords = this.deps.fieldComposition.fieldRepos.records.listByWorkspace(workspaceId)
      .filter((record) => !erased.has(`source_record:${record.record_id}`));
    const groundedEvidenceIds = new Set(bindings
      .filter((binding) => sourceRecords.some((record) => record.record_id === binding.record_id))
      .map((binding) => binding.evidence_object_id));
    return {
      groundedEvidenceIds,
      sourceRecords: sourceRecords.filter((record) => bindings.some((binding) =>
        binding.record_id === record.record_id &&
        eligibleEvidence.has(binding.evidence_object_id)))
    };
  }

  private buildMemoryCorrectionProofs(
    input: EffectInput,
    delivery: ContextDeliveryRecord,
    memory: Readonly<MemoryEntry>,
    records: readonly SourceRecord[],
    targetFact: string,
    factSnapshotId: string
  ) {
    const actor = this.actorProof(input, delivery);
    const lineage = this.boundProof("lineage", `lineage:${memory.object_id}`, input, memory.created_at);
    const snapshot = this.boundProof("governance_snapshot", factSnapshotId, input, memory.created_at);
    const correctionProofs = this.correctionProofs(input, memory.created_at, targetFact);
    return Object.freeze([
      { proof: actor, witness: proofWitness(actor, null, delivery.audit_event_id) },
      ...records.map((record) => {
        const proof = this.sourceProofForTarget(input, record);
        return { proof, witness: proofWitness(proof, record, null) };
      }),
      { proof: lineage, witness: proofWitness(lineage, null, null) },
      { proof: snapshot, witness: proofWitness(snapshot, null, null) },
      ...correctionProofs.map((proof) => ({ proof, witness: proofWitness(proof, null, null) }))
    ]);
  }

  private buildVerifiedProofs(
    input: EffectInput,
    delivery: ContextDeliveryRecord,
    claim: Readonly<ClaimForm>,
    records: readonly SourceRecord[],
    targetFact: string,
    factSnapshotId: string
  ) {
    const actor = this.actorProof(input, delivery);
    const snapshot = this.boundProof("governance_snapshot", factSnapshotId, input, claim.created_at);
    const correctionProofs = input.action === "correct" && input.correction !== undefined
      ? this.correctionProofs(input, claim.created_at, targetFact)
      : [];
    return Object.freeze([
      { proof: actor, witness: proofWitness(actor, null, delivery.audit_event_id) },
      ...records.map((record) => {
        const proof = this.sourceProof(input, claim, record);
        return { proof, witness: proofWitness(proof, record, null) };
      }),
      { proof: snapshot, witness: proofWitness(snapshot, null, null) },
      ...correctionProofs.map((proof) => ({ proof, witness: proofWitness(proof, null, null) }))
    ]);
  }

  private correctionProofs(
    input: EffectInput,
    predecessorValidFrom: string,
    targetFact: string
  ): readonly ProofRecord[] {
    const predecessorId = hashCorrectionPredecessorId({
      workspace_id: input.workspaceId,
      target: input.targetObjectId,
      target_fact: targetFact
    }, this.sha256);
    const successorId = hashCorrectionSuccessorId({
      workspace_id: input.workspaceId,
      target: input.targetObjectId,
      correction: input.correction!
    }, this.sha256);
    return Object.freeze([
      this.boundProof("predecessor", predecessorId, input, predecessorValidFrom),
      this.boundProof("successor", successorId, input, input.effectiveAsOf)
    ]);
  }

  private boundProof(
    kind: "governance_snapshot" | "lineage" | "predecessor" | "successor",
    id: string,
    input: EffectInput,
    validFrom: string
  ): ProofRecord {
    return Object.freeze({
      id,
      workspace_id: input.workspaceId,
      kind,
      target: input.targetObjectId,
      scope: input.scope,
      recorded_at: validFrom,
      event_time: validFrom,
      valid_from: validFrom,
      valid_to: null
    });
  }

  private actorProof(input: EffectInput, delivery: ContextDeliveryRecord): ProofRecord {
    return Object.freeze({
      id: this.proofId("actor_authority", input, delivery.audit_event_id),
      workspace_id: input.workspaceId,
      kind: "actor_authority",
      target: input.targetObjectId,
      scope: input.scope,
      actor_id: input.actorId,
      run_id: input.runId,
      delivery_id: input.deliveryId,
      recorded_at: delivery.delivered_at,
      event_time: delivery.delivered_at,
      valid_from: delivery.delivered_at,
      valid_to: null
    });
  }

  private sourceProof(input: EffectInput, claim: ClaimForm, record: SourceRecord): ProofRecord {
    return this.sourceProofForTarget(input, record, claim.object_id);
  }

  private sourceProofForTarget(
    input: EffectInput,
    record: SourceRecord,
    target: string = input.targetObjectId
  ): ProofRecord {
    return Object.freeze({
      id: this.proofId("source_grounding", input, record.record_id),
      workspace_id: input.workspaceId,
      kind: "source_grounding",
      target,
      scope: input.scope,
      recorded_at: record.recorded_at,
      event_time: record.event_time ?? record.recorded_at,
      valid_from: record.valid_from ?? record.event_time ?? record.recorded_at,
      valid_to: record.valid_to
    });
  }

  private listErasedSubjectKeys(workspaceId: string): ReadonlySet<string> {
    const rows = this.deps.database.connection.prepare(`
      SELECT subject_kind, subject_id FROM projection_erase_barriers WHERE workspace_id = ?
    `).all(workspaceId) as readonly { subject_kind: string; subject_id: string }[];
    return new Set(rows.map((row) => `${row.subject_kind}:${row.subject_id}`));
  }

  private isSubjectErased(workspaceId: string, subjectId: string): boolean {
    return this.deps.database.connection.prepare(`
      SELECT 1 FROM projection_erase_barriers
      WHERE workspace_id = ? AND subject_id = ? LIMIT 1
    `).get(workspaceId, subjectId) !== undefined;
  }

  private proofId(kind: string, input: EffectInput, witness: string): string {
    return `proof:${this.sha256(JSON.stringify([
      "resolution_effect_authority_v2", kind, input.workspaceId, input.actorId,
      input.runId, input.deliveryId, input.targetObjectId, input.scope,
      input.effectiveAsOf, witness
    ]))}`;
  }
}

type DecisionContext = Awaited<ReturnType<ResolutionEffectAuthority["loadDecisionContext"]>>;

function createRequestLookup(
  request: EffectRequest,
  proofs: readonly ProofRecord[],
  context: DecisionContext
): ProofEffectLookup {
  return {
    findReceipts: (workspaceId, ids) => proofs.filter((proof) =>
      proof.workspace_id === workspaceId && ids.includes(proof.id)),
    isBridgeRevoked: () => context === null,
    competingClaims: () => context?.competing ?? [],
    isErased: () => context?.erased ?? true,
    readTargetTime: (workspaceId, target) =>
      workspaceId === request.workspace_id && target === request.target
        ? context?.targetTime ?? null
        : null
  };
}

function proofWitness(
  proof: ProofRecord,
  source: SourceRecord | null,
  authorityEventId: string | null
): ProofEffectWitness {
  return Object.freeze({
    receipt_id: proof.id,
    kind: proof.kind,
    authority_event_id: authorityEventId,
    source_record_id: source?.record_id ?? null,
    source_content_digest: source?.content_digest ?? null
  });
}

function claimTime(
  claim: Readonly<ClaimForm>,
  hasEvidence: boolean,
  targetScope: ClaimForm["scope_class"]
): CompetingClaim {
  return Object.freeze({
    id: claim.object_id,
    has_evidence: hasEvidence,
    scope_compatible: claim.scope_class === targetScope,
    recorded_at: claim.created_at,
    event_time: claim.created_at,
    valid_from: claim.created_at,
    valid_to: null
  });
}

function claimFrontierFact(
  claim: Readonly<ClaimForm>,
  groundedEvidenceIds: ReadonlySet<string>,
  targetScope: ClaimForm["scope_class"]
): string {
  return canonicalEffectClaimFact({
    object_id: claim.object_id,
    claim_status: claim.claim_status,
    canonical_key: claim.governance_subject.canonical_key,
    scope_class: claim.scope_class,
    created_at: claim.created_at,
    updated_at: claim.updated_at,
    has_evidence: claim.evidence_refs.some((id) => groundedEvidenceIds.has(id)),
    scope_compatible: claim.scope_class === targetScope
  });
}

function memoryFrontierFact(
  memory: Readonly<MemoryEntry>,
  sha256: FieldContractSha256
): string {
  return canonicalEffectMemoryFact({
    object_id: memory.object_id,
    lifecycle_state: memory.lifecycle_state,
    scope_class: memory.scope_class,
    created_at: memory.created_at,
    updated_at: memory.updated_at,
    content_digest: hashContentDigest(memory.content, sha256),
    evidence_refs: memory.evidence_refs
  });
}

function memoryTime(memory: Readonly<MemoryEntry>) {
  return Object.freeze({
    recorded_at: memory.updated_at,
    event_time: memory.created_at,
    valid_from: memory.created_at,
    valid_to: null
  });
}

function isLiveClaim(claim: Readonly<ClaimForm>): boolean {
  return !["archived", "rejected", "superseded"].includes(claim.claim_status);
}
