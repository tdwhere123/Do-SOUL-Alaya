import {
  EvidenceCapsuleSchema,
  OPEN_SEMANTIC_FACTOR_FORMATION_REJECTED_ADMISSION,
  MemoryGovernanceEventType,
  SoulEvidenceCreatedPayloadSchema,
  type EvidenceCapsule,
  type EvidenceFactFrameFormationProposal,
  type EvidenceSearchProjection,
  type EventLogEntry,
  type FactorIncidencePort,
  type FieldContractSha256,
  type OpenSemanticFactorFormationAdmission,
  type SourceAdmissionPort
} from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
import type { OpenSemanticFactorExtractionPort } from
  "../../semantic/open-semantic-factor-extraction-port.js";
import type { EvidenceFactFrameProposalNormalizer } from
  "../fact-frame-formation/declarative-normalizer.js";
import {
  admitEvidenceFieldFormation,
  planEvidenceFormation,
  type EvidenceFormationPlan
} from "./formation-plan.js";
import type { FieldFormationStores } from "./field-stores.js";
import { appendSourceRecordAdmitted } from "./source-admission-audit.js";

export async function createEvidenceCapsule(input: Readonly<{
  readonly capsuleInput: Omit<
    EvidenceCapsule,
    "object_id" | "object_kind" | "schema_version" | "lifecycle_state" | "created_at" | "updated_at"
  >;
  readonly searchProjections: readonly Readonly<EvidenceSearchProjection>[];
  readonly factFrameProposal?: Readonly<EvidenceFactFrameFormationProposal>;
  readonly semanticFactorProposal?: Readonly<OpenSemanticFactorFormationAdmission>;
  readonly evidenceCapsuleRepo: {
    create(
      capsule: EvidenceCapsule,
      searchProjections?: readonly Readonly<EvidenceSearchProjection>[],
      factFrameFormation?: EvidenceFormationPlan["factFrameCapture"],
      semanticFactorFormation?: EvidenceFormationPlan["semanticFormation"]
      , semanticCompleteness?: EvidenceFormationPlan["semanticCompleteness"]
    ): Promise<Readonly<EvidenceCapsule>>;
  };
  readonly eventLogRepo: {
    append(event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">):
      EventLogEntry | Promise<EventLogEntry>;
  };
  readonly runtimeNotifier: {
    notifyEntry(entry: EventLogEntry): void | Promise<void>;
  };
  readonly factFrameProposalNormalizer?: Readonly<EvidenceFactFrameProposalNormalizer> | null;
  readonly warn?: (message: string, meta: Record<string, unknown>) => void;
  readonly generateObjectId: () => string;
  readonly now: () => string;
  readonly sha256?: FieldContractSha256;
  readonly sourceAdmission?: SourceAdmissionPort;
  readonly factorIncidence?: FactorIncidencePort;
  readonly fieldStores?: FieldFormationStores;
  readonly semanticExtractor?: OpenSemanticFactorExtractionPort;
}>): Promise<Readonly<EvidenceCapsule>> {
  const timestamp = input.now();
  const evidence = parseCreatedCapsule(input, timestamp);
  const formation = planOptionalFormation(input, evidence);
  const event = await appendCreated(input.eventLogRepo, evidence);
  const created = await input.evidenceCapsuleRepo.create(
    evidence,
    formation.searchProjections,
    formation.factFrameCapture,
    formation.semanticFormation,
    formation.semanticCompleteness
  );
  await admitOptionalFieldFormation(input, created, formation);
  await input.runtimeNotifier.notifyEntry(event);
  return created;
}

function parseCreatedCapsule(
  input: Readonly<{
    readonly capsuleInput: Omit<
      EvidenceCapsule,
      "object_id" | "object_kind" | "schema_version" | "lifecycle_state" | "created_at" | "updated_at"
    >;
    readonly generateObjectId: () => string;
  }>,
  timestamp: string
): EvidenceCapsule {
  try {
    return EvidenceCapsuleSchema.parse({
      ...input.capsuleInput,
      object_id: input.generateObjectId(),
      object_kind: "evidence_capsule",
      schema_version: 1,
      lifecycle_state: "active",
      created_at: timestamp,
      updated_at: timestamp
    });
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid evidence capsule payload", { cause: error });
  }
}

function planOptionalFormation(
  input: Readonly<{
    readonly searchProjections: readonly Readonly<EvidenceSearchProjection>[];
    readonly factFrameProposal?: Readonly<EvidenceFactFrameFormationProposal>;
    readonly semanticFactorProposal?: Readonly<OpenSemanticFactorFormationAdmission>;
    readonly factFrameProposalNormalizer?: Readonly<EvidenceFactFrameProposalNormalizer> | null;
    readonly warn?: (message: string, meta: Record<string, unknown>) => void;
    readonly semanticExtractor?: OpenSemanticFactorExtractionPort;
  }>,
  evidence: EvidenceCapsule
): EvidenceFormationPlan {
  idleExtractor(input.semanticExtractor);
  try {
    return planEvidenceFormation({
      evidence,
      searchProjections: input.searchProjections,
      factFrameProposal: input.factFrameProposal,
      semanticFactorProposal: input.semanticFactorProposal,
      factFrameProposalNormalizer: input.factFrameProposalNormalizer
    });
  } catch (error) {
    input.warn?.("optional evidence formation failed", {
      evidence_object_id: evidence.object_id,
      error: error instanceof Error ? error.message : String(error)
    });
    return planEvidenceFormation({
      evidence,
      searchProjections: [],
      ...(input.semanticFactorProposal === undefined ? {} : {
        semanticFactorProposal: OPEN_SEMANTIC_FACTOR_FORMATION_REJECTED_ADMISSION
      })
    });
  }
}

async function admitOptionalFieldFormation(
  input: Readonly<{
    readonly sha256?: FieldContractSha256;
    readonly sourceAdmission?: SourceAdmissionPort;
    readonly factorIncidence?: FactorIncidencePort;
    readonly fieldStores?: FieldFormationStores;
    readonly semanticExtractor?: OpenSemanticFactorExtractionPort;
    readonly warn?: (message: string, meta: Record<string, unknown>) => void;
    readonly eventLogRepo: {
      append(event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">):
        EventLogEntry | Promise<EventLogEntry>;
    };
  }>,
  evidence: EvidenceCapsule,
  views: EvidenceFormationPlan
): Promise<void> {
  try {
    const admitted = admitEvidenceFieldFormation({
      evidence,
      views,
      sha256: input.sha256,
      sourceAdmission: input.sourceAdmission,
      factorIncidence: input.factorIncidence,
      fieldStores: input.fieldStores,
      semanticExtractor: input.semanticExtractor
    });
    if (admitted !== null) {
      await appendSourceRecordAdmitted(input.eventLogRepo, admitted);
    }
  } catch (error) {
    input.warn?.("optional evidence formation failed", {
      evidence_object_id: evidence.object_id,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function appendCreated(
  eventLogRepo: {
    append(event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">):
      EventLogEntry | Promise<EventLogEntry>;
  },
  evidence: EvidenceCapsule
): Promise<EventLogEntry> {
  return await eventLogRepo.append({
    event_type: MemoryGovernanceEventType.SOUL_EVIDENCE_CREATED,
    entity_type: "evidence_capsule",
    entity_id: evidence.object_id,
    workspace_id: evidence.workspace_id,
    run_id: evidence.run_id,
    caused_by: evidence.created_by,
    payload_json: SoulEvidenceCreatedPayloadSchema.parse({
      object_id: evidence.object_id,
      object_kind: evidence.object_kind,
      workspace_id: evidence.workspace_id,
      run_id: evidence.run_id
    })
  });
}

function idleExtractor(extractor?: OpenSemanticFactorExtractionPort): void {
  if (extractor === undefined) return;
}
