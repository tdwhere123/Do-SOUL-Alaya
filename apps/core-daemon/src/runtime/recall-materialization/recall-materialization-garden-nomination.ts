import {
  PathGovernanceClass,
  type RelationValidity
} from "@do-soul/alaya-protocol";
import type {
  PathRelationProposalPayload,
  TemporalRelationAssertionPort as SoulTemporalRelationAssertionPort
} from "@do-soul/alaya-soul";
import type { SqliteEvidenceCapsuleRepo, SqliteEventLogRepo } from "@do-soul/alaya-storage";

type GardenPathRelationProposalPort = {
  createPathRelationProposal(input: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly targetObjectId: string;
    readonly reason: string;
    readonly sourceSignalId: string;
    readonly proposedPathRelation: PathRelationProposalPayload;
  }): Promise<Readonly<{ readonly object_kind: string; readonly object_id: string }>>;
};

type GardenNominationAdmission = Parameters<SoulTemporalRelationAssertionPort["admit"]>[0];

export function createGardenRelationNominationPort(
  input: Readonly<{
    readonly eventLogRepo: SqliteEventLogRepo;
    readonly evidenceCapsuleRepo: SqliteEvidenceCapsuleRepo;
  }>,
  pathRelationProposalPort: GardenPathRelationProposalPort
): SoulTemporalRelationAssertionPort {
  return {
    admit: async (admission) => {
      await assertSourceEventMatches(input.eventLogRepo, admission);
      const validity = await resolveNominationValidity(input.evidenceCapsuleRepo, admission);
      return await pathRelationProposalPort.createPathRelationProposal({
        workspaceId: admission.workspaceId,
        runId: admission.runId,
        sourceSignalId: admission.sourceSignalId,
        targetObjectId: readNominationTargetObjectId(admission),
        reason: buildNominationReason(admission, validity),
        proposedPathRelation: buildNominatedPathRelation(admission, validity)
      });
    }
  };
}

async function assertSourceEventMatches(
  eventLogRepo: SqliteEventLogRepo,
  admission: GardenNominationAdmission
): Promise<void> {
  const sourceEventAnchor = admission.sourceEventAnchor;
  const sourceEvent = (await eventLogRepo.queryByEntity(
    "candidate_memory_signal",
    admission.sourceSignalId
  )).find((event) => event.event_id === sourceEventAnchor.event_id);
  if (
    sourceEvent === undefined ||
    sourceEvent.event_type !== sourceEventAnchor.event_type ||
    sourceEvent.entity_type !== "candidate_memory_signal" ||
    sourceEvent.entity_id !== admission.sourceSignalId ||
    sourceEvent.workspace_id !== admission.workspaceId
  ) {
    throw new Error(`Relation source event ${sourceEventAnchor.event_id} does not match its anchor.`);
  }
}

async function resolveNominationValidity(
  evidenceCapsuleRepo: SqliteEvidenceCapsuleRepo,
  admission: GardenNominationAdmission
): Promise<RelationValidity> {
  const requested = admission.validity;
  if (requested.kind === "timeless") {
    return requested;
  }
  const evidenceSourceTime = await readEarliestEvidenceSourceTime(
    evidenceCapsuleRepo,
    admission.evidenceIds
  );
  if (
    evidenceSourceTime === null ||
    evidenceSourceTime === admission.sourceEventAnchor.occurred_at
  ) {
    return requested;
  }
  if (requested.kind === "open") {
    return { kind: "open", valid_from: evidenceSourceTime };
  }
  return {
    kind: "bounded",
    valid_from: evidenceSourceTime,
    valid_to: requested.valid_to
  };
}

async function readEarliestEvidenceSourceTime(
  evidenceCapsuleRepo: SqliteEvidenceCapsuleRepo,
  evidenceIds: readonly string[]
): Promise<string | null> {
  let earliest: string | null = null;
  for (const evidenceId of evidenceIds) {
    const capsule = await evidenceCapsuleRepo.findById(evidenceId);
    const sourceTime = capsule?.event_anchor?.occurred_at;
    if (typeof sourceTime !== "string" || sourceTime.length === 0) {
      continue;
    }
    if (earliest === null || sourceTime < earliest) {
      earliest = sourceTime;
    }
  }
  return earliest;
}

function readNominationTargetObjectId(admission: GardenNominationAdmission): string {
  const source = admission.anchors.source_anchor;
  if (source.kind === "object") {
    return source.object_id;
  }
  throw new Error("Garden relation nomination requires an object source anchor.");
}

function buildNominationReason(
  admission: GardenNominationAdmission,
  validity: RelationValidity
): string {
  return [
    `Nominate ${admission.relationKind} PathRelation.`,
    `validity=${JSON.stringify(validity)}`,
    `source_event_occurred_at=${admission.sourceEventAnchor.occurred_at}`
  ].join(" ");
}

function buildNominatedPathRelation(
  admission: GardenNominationAdmission,
  validity: RelationValidity
): PathRelationProposalPayload {
  return {
    target_anchor: admission.anchors.target_anchor,
    constitution: {
      relation_kind: admission.relationKind,
      why_this_relation_exists: [
        "garden relation nomination (proposal only)",
        `validity=${JSON.stringify(validity)}`
      ]
    },
    effect_vector: {
      salience: 0.5,
      recall_bias: 0.5,
      verification_bias: 0.1,
      unfinishedness_bias: 0,
      default_manifestation_preference: "lens_entry"
    },
    plasticity_state: {
      strength: 0.4,
      direction_bias: "source_to_target",
      stability_class: "normal",
      support_events_count: 1,
      contradiction_events_count: 0
    },
    lifecycle: {
      status: "active",
      retirement_rule: "governance_reject_or_low_strength"
    },
    legitimacy: {
      evidence_basis: [
        "garden:relation_nomination",
        ...admission.evidenceIds.map((evidenceId) => `evidence:${evidenceId}`)
      ],
      governance_class: PathGovernanceClass.HINT_ONLY
    }
  };
}
