import {
  errorNameOf,
  isEvidenceProjectionIntegrityError,
  toErrorMessage
} from "../../runtime/recall-service-helpers.js";
import type { RecallQualifiedEvidence } from "../../runtime/recall-service-ports.js";
import { compareText } from "../../../shared/compare-text.js";
import type {
  CollectRecallEvidenceContextsParams,
  SemanticFactorFormationLookup
} from "./evidence-contexts-types.js";

export async function loadQualifiedSemanticFormations(
  params: CollectRecallEvidenceContextsParams,
  evidenceIds: readonly string[]
): Promise<SemanticFactorFormationLookup> {
  const find = params.dependencies.evidenceSearchPort?.findRecallQualifiedByIds;
  if (find === undefined) {
    return Object.freeze({
      qualified: Object.freeze([]),
      unavailableEvidenceIds: Object.freeze([...evidenceIds])
    });
  }
  const unavailableEvidenceIds = new Set<string>();
  const qualified = await loadQualifiedEvidenceWithIsolation({
    params,
    evidenceIds,
    message: "semantic factor evidence context lookup failed",
    operation: "qualified_semantic_factor_lookup",
    onUnavailableEvidenceIds: (ids) => ids.forEach((id) => unavailableEvidenceIds.add(id)),
    load: async (ids) => await find.call(
      params.dependencies.evidenceSearchPort,
      params.workspaceId,
      ids.map((objectId) => Object.freeze({ object_id: objectId }))
    )
  });
  const returnedIds = new Set(qualified.map((item) => item.capsule.object_id));
  for (const evidenceId of evidenceIds) {
    if (!returnedIds.has(evidenceId)) unavailableEvidenceIds.add(evidenceId);
  }
  return Object.freeze({
    qualified,
    unavailableEvidenceIds: Object.freeze([...unavailableEvidenceIds].sort(compareText))
  });
}

export async function loadQualifiedFactKeys(
  params: CollectRecallEvidenceContextsParams,
  evidenceIds: readonly string[]
): Promise<readonly RecallQualifiedEvidence[]> {
  const find = params.dependencies.evidenceSearchPort
    ?.findRecallQualifiedFactKeysByIds;
  if (find === undefined) return Object.freeze([]);
  return await loadQualifiedEvidenceWithIsolation({
    params,
    evidenceIds,
    message: "fact-key evidence context lookup failed",
    operation: "qualified_fact_key_lookup",
    load: async (ids) => await find.call(
      params.dependencies.evidenceSearchPort,
      params.workspaceId,
      ids
    )
  });
}

async function loadQualifiedEvidenceWithIsolation(input: Readonly<{
  readonly params: CollectRecallEvidenceContextsParams;
  readonly evidenceIds: readonly string[];
  readonly message: string;
  readonly operation: string;
  readonly onUnavailableEvidenceIds?: (ids: readonly string[]) => void;
  readonly load: (ids: readonly string[]) => Promise<readonly RecallQualifiedEvidence[]>;
}>): Promise<readonly RecallQualifiedEvidence[]> {
  try {
    return await input.load(input.evidenceIds);
  } catch (error) {
    if (!isEvidenceProjectionIntegrityError(error)) throw error;
    if (input.evidenceIds.length > 1) {
      const middle = Math.ceil(input.evidenceIds.length / 2);
      const left = await loadQualifiedEvidenceWithIsolation({
        ...input,
        evidenceIds: input.evidenceIds.slice(0, middle)
      });
      const right = await loadQualifiedEvidenceWithIsolation({
        ...input,
        evidenceIds: input.evidenceIds.slice(middle)
      });
      return Object.freeze([...left, ...right]);
    }
    input.params.warn(input.message, {
      workspace_id: input.params.workspaceId,
      operation: input.operation,
      ...(input.evidenceIds.length === 1
        ? { evidence_object_id: input.evidenceIds[0] }
        : {}),
      errorName: errorNameOf(error),
      error: toErrorMessage(error)
    });
    input.onUnavailableEvidenceIds?.(input.evidenceIds);
    return Object.freeze([]);
  }
}
