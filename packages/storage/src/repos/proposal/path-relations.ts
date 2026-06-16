import {
  PathGovernanceClass,
  PathRelationSchema,
  serializePathAnchorRef,
  type PathRelation
} from "@do-soul/alaya-protocol";
import { StorageError } from "../../shared/errors.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import type { PathRelationProposalPayload } from "./types.js";
import type { ProposalPathRelationRow } from "./rows.js";
import type { parseAcceptedPathRelationGovernanceInput } from "./acceptance.js";

export function serializeProposedPathRelation(
  value: PathRelationProposalPayload | null
): string | null {
  if (value === null) {
    return null;
  }

  const parsed = parsePathRelationProposalPayload(value);
  return JSON.stringify(parsed);
}

export function parseProposedPathRelation(value: string | null): Readonly<PathRelationProposalPayload> | null {
  if (value === null) {
    return null;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(value);
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to parse proposal proposed_path_relation JSON.", error);
  }

  return parsePathRelationProposalPayload(parsedJson);
}

export function parsePathRelationProposalPayload(value: unknown): Readonly<PathRelationProposalPayload> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate proposal proposed_path_relation.");
  }
  const candidate = value as Partial<PathRelationProposalPayload>;
  try {
    const relation = PathRelationSchema.parse({
      path_id: "proposal-payload-validation",
      workspace_id: "proposal-payload-validation-workspace",
      anchors: {
        source_anchor: { kind: "object", object_id: "proposal-payload-validation-source" },
        target_anchor: candidate.target_anchor
      },
      constitution: candidate.constitution,
      effect_vector: candidate.effect_vector,
      plasticity_state: candidate.plasticity_state,
      lifecycle: candidate.lifecycle,
      legitimacy: candidate.legitimacy,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z"
    });
    return deepFreeze({
      target_anchor: relation.anchors.target_anchor,
      constitution: relation.constitution,
      effect_vector: relation.effect_vector,
      plasticity_state: relation.plasticity_state,
      lifecycle: relation.lifecycle,
      legitimacy: relation.legitimacy
    });
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate proposal proposed_path_relation.", error);
  }
}

export function createStrictlyGovernedPathRelation(
  input: ReturnType<typeof parseAcceptedPathRelationGovernanceInput>
): Readonly<PathRelation> {
  return PathRelationSchema.parse({
    path_id: input.path_id_on_create,
    workspace_id: input.workspace_id,
    anchors: {
      source_anchor: { kind: "object", object_id: input.target_object_id },
      target_anchor: {
        kind: "object_facet",
        object_id: input.target_object_id,
        facet_key: "strictly_governed_constraint"
      }
    },
    constitution: {
      relation_kind: "governance_constraint",
      why_this_relation_exists: ["operator accepted strictly_governed governance promotion"]
    },
    effect_vector: {
      salience: 1,
      recall_bias: 1,
      verification_bias: 1,
      unfinishedness_bias: 0,
      default_manifestation_preference: "stance_bias"
    },
    plasticity_state: {
      strength: 1,
      direction_bias: "source_to_target",
      stability_class: "pinned",
      support_events_count: 1,
      contradiction_events_count: 0,
      last_reinforced_at: input.updated_at
    },
    lifecycle: {
      status: "active",
      retirement_rule: "manual"
    },
    legitimacy: {
      evidence_basis: [input.caused_by],
      governance_class: PathGovernanceClass.STRICTLY_GOVERNED
    },
    created_at: input.updated_at,
    updated_at: input.updated_at
  });
}

export function createPathRelationFromProposalPayload(
  input: ReturnType<typeof parseAcceptedPathRelationGovernanceInput>,
  payload: Readonly<PathRelationProposalPayload>
): Readonly<PathRelation> {
  return PathRelationSchema.parse({
    path_id: input.path_id_on_create,
    workspace_id: input.workspace_id,
    anchors: {
      source_anchor: { kind: "object", object_id: input.target_object_id },
      target_anchor: payload.target_anchor
    },
    constitution: payload.constitution,
    effect_vector: payload.effect_vector,
    plasticity_state: {
      ...payload.plasticity_state,
      last_reinforced_at: payload.plasticity_state.last_reinforced_at ?? input.updated_at
    },
    lifecycle: payload.lifecycle,
    legitimacy: {
      ...payload.legitimacy,
      evidence_basis: appendUniqueEvidenceBasis(
        payload.legitimacy.evidence_basis,
        input.caused_by
      )
    },
    created_at: input.updated_at,
    updated_at: input.updated_at
  });
}

export function applyPathRelationProposal(
  existing: Readonly<PathRelation>,
  input: ReturnType<typeof parseAcceptedPathRelationGovernanceInput>,
  payload: Readonly<PathRelationProposalPayload> | null
): Readonly<PathRelation> {
  const proposedLegitimacy = payload?.legitimacy ?? existing.legitimacy;
  return PathRelationSchema.parse({
    ...existing,
    legitimacy: {
      ...proposedLegitimacy,
      evidence_basis: appendUniqueEvidenceBasis(
        existing.legitimacy.evidence_basis,
        ...proposedLegitimacy.evidence_basis,
        input.caused_by
      ),
      governance_class:
        payload === null
          ? PathGovernanceClass.STRICTLY_GOVERNED
          : proposedLegitimacy.governance_class
    },
    updated_at: input.updated_at
  });
}

export function pathRelationMatchesProposalPayload(
  relation: Readonly<PathRelation>,
  sourceObjectId: string,
  payload: Readonly<PathRelationProposalPayload>
): boolean {
  return (
    relation.anchors.source_anchor.kind === "object" &&
    relation.anchors.source_anchor.object_id === sourceObjectId &&
    serializePathAnchorRef(relation.anchors.target_anchor) ===
      serializePathAnchorRef(payload.target_anchor)
  );
}

export function parseProposalPathRelationRow(row: ProposalPathRelationRow): Readonly<PathRelation> {
  return PathRelationSchema.parse({
    path_id: row.path_id,
    workspace_id: row.workspace_id,
    anchors: parseJsonField(row.anchors_json, "anchors"),
    constitution: parseJsonField(row.constitution_json, "constitution"),
    effect_vector: parseJsonField(row.effect_vector_json, "effect_vector"),
    plasticity_state: parseJsonField(row.plasticity_state_json, "plasticity_state"),
    lifecycle: parseJsonField(row.lifecycle_json, "lifecycle"),
    legitimacy: parseJsonField(row.legitimacy_json, "legitimacy"),
    created_at: row.created_at,
    updated_at: row.updated_at
  });
}

function parseJsonField(value: string, fieldName: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new StorageError(
      "VALIDATION_FAILED",
      `Failed to parse path relation ${fieldName}.`,
      error
    );
  }
}

export function appendUniqueEvidenceBasis(
  current: readonly string[],
  ...nextValues: readonly string[]
): readonly string[] {
  const result = [...current];
  for (const next of nextValues) {
    if (!result.includes(next)) {
      result.push(next);
    }
  }
  return result;
}
