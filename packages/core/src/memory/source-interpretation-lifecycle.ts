import {
  SourceInterpretationInvalidationSchema, SourceInterpretationInvalidatedPayloadSchema,
  SourceSemanticPublishedInterpretationSchema, sourceSemanticInterpretationIdentity,
  type SourceInterpretationInvalidation, type SourceInterpretationInvalidationResult,
  type FieldContractSha256, type SourceSemanticResourceLedger
} from "@do-soul/alaya-protocol";
import { CoreError } from "../shared/errors.js";
import type { EvidenceServiceDependencies } from "./evidence-service.js";
import type { FieldFormationStores } from "./evidence-create/field-stores.js";
import { sourceSemanticCapsuleKeys } from "./evidence-create/source-semantic-capsule.js";
import { verifySourceSemanticSourceBinding } from "./evidence-create/source-interpretation-packet-publication.js";
import type { EventPublisher } from "../runtime/event-publisher.js";
import { authorizeSemanticScope } from "../recall/runtime/source-semantic-access.js";
import { authorizedScopesFromAdmission } from "../recall/conditional-field/observers/observation-admission.js";

type LifecycleCapsule = Readonly<{ objectId: string; gist: string; lifecycleState: string; sourceHash: string }>;

/** Request-scoped mechanical reads share the live source authority and one resource ledger. */
export interface SourceInterpretationLifecycleReadContext {
  readonly meter: SourceSemanticResourceLedger;
  readonly stores: Pick<FieldFormationStores, "getCurrentRecord">;
  readCapsule(workspaceId: string, objectIds: readonly string[]): LifecycleCapsule | null;
}

type Owner = Pick<EvidenceServiceDependencies, "evidenceCapsuleRepo"> & {
  readonly eventPublisher: Pick<EventPublisher, "decideAppendThenApply">;
  readonly read: SourceInterpretationLifecycleReadContext;
  readonly sha256: FieldContractSha256;
  readonly now: () => string;
};

/** Retires only the identified H. Source bytes and all other hypotheses retain their own lifecycle. */
export async function invalidateSourceInterpretation(owner: Owner,
  value: SourceInterpretationInvalidation): Promise<SourceInterpretationInvalidationResult> {
  const meter = owner.read.meter;
  meter.retain(value, "invalidation request");
  const parsed = SourceInterpretationInvalidationSchema.safeParse(value);
  if (!parsed.success) throw new CoreError("VALIDATION", "invalid source interpretation invalidation", { cause: parsed.error });
  const input = parsed.data, repo = owner.evidenceCapsuleRepo;
  const archive = repo.archiveSourceInterpretationInCurrentTransaction;
  if (archive === undefined) {
    throw new CoreError("CONFLICT", "source interpretation lifecycle transaction port is unavailable", { subCode: "PORT_UNAVAILABLE" });
  }
  return owner.eventPublisher.decideAppendThenApply<SourceInterpretationInvalidationResult>(() => {
    const evidence = owner.read.readCapsule(input.workspace_id,
      sourceSemanticCapsuleKeys(input.source_interpretation_id, owner.sha256, input.workspace_id));
    if (evidence === null) throw new CoreError("NOT_FOUND", "source interpretation not found in workspace");
    verifyCurrentBinding(owner, input, evidence);
    const result = { source_interpretation_id: input.source_interpretation_id, evidence_object_id: evidence.objectId };
    meter.retain(result, "invalidation result");
    if (evidence.lifecycleState === "archived") return { eventInputs: [], apply: () => ({ ...result, status: "already_invalidated" }) };
    if (evidence.lifecycleState !== "active") throw new CoreError("CONFLICT", "source interpretation is not active");
    const occurredAt = owner.now();
    const payload = { ...input, evidence_object_id: evidence.objectId,
      from_state: "active", to_state: "archived", semantic_status: "unreviewed", occurred_at: occurredAt };
    meter.retain(payload, "invalidation audit");
    meter.charge(2, 0, "invalidation append and archive");
    return { eventInputs: [{
      event_type: "source.interpretation.invalidated", entity_type: "evidence_capsule", entity_id: evidence.objectId,
      workspace_id: input.workspace_id, run_id: input.run_id, caused_by: input.provenance.reporter_id,
      payload_json: SourceInterpretationInvalidatedPayloadSchema.parse(payload)
    }], apply: () => {
      if (!archive.call(repo, { objectId: evidence.objectId, workspaceId: input.workspace_id,
        expectedGist: evidence.gist, sourceHash: input.source.content_digest, updatedAt: occurredAt })) {
        throw new CoreError("CONFLICT", "source interpretation changed before invalidation");
      }
      return { ...result, status: "invalidated" };
    } };
  });
}

function verifyCurrentBinding(owner: Owner, input: SourceInterpretationInvalidation, evidence: LifecycleCapsule): void {
  const meter = owner.read.meter;
  meter.charge(evidence.gist.length + 1, evidence.gist.length * 4, "invalidation interpretation decoding");
  let raw: unknown;
  try { raw = JSON.parse(evidence.gist); } catch { throw new CoreError("VALIDATION", "stored interpretation is malformed"); }
  meter.retain(raw, "invalidation interpretation validation");
  const parsed = SourceSemanticPublishedInterpretationSchema.safeParse(raw);
  if (!parsed.success) throw new CoreError("VALIDATION", "capsule is not a published source interpretation");
  const bound = parsed.data;
  meter.retain(bound, "invalidation interpretation identity");
  if (bound.interpretation_id !== input.source_interpretation_id ||
    sourceSemanticInterpretationIdentity(bound.interpretation, owner.sha256) !== input.source_interpretation_id ||
    bound.interpretation.source.source_id !== input.source.source_id ||
    bound.interpretation.source.source_version !== input.source.source_version ||
    bound.interpretation.source.content_digest !== input.source.content_digest ||
    evidence.sourceHash !== input.source.content_digest) {
    throw new CoreError("VALIDATION", "invalidation differs from the exact interpretation source binding");
  }
  const current = owner.read.stores.getCurrentRecord(input.workspace_id, input.source.source_id);
  if (current === null) throw new CoreError("VALIDATION", "source is not currently admitted");
  verifySourceSemanticSourceBinding(bound.interpretation, bound.source_target, current, owner.sha256);
  const { authorized_scopes } = authorizedScopesFromAdmission(input.authorized_scopes);
  if (authorized_scopes === undefined) throw new CoreError("VALIDATION", "source invalidation requires admitted scopes");
  authorizeSemanticScope(current.scope_class, authorized_scopes);
}
