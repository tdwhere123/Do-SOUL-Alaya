import { describe, expect, it, vi } from "vitest";
import {
  CONDITIONAL_FIELD_GENERATION_OPERATOR_ID,
  FIELD_OPERATOR_MANIFEST,
  PROJECTION_GENERATION_OPERATOR_ID,
  fieldOperatorManifestDigest,
  hashGenerationId,
  verifyFieldProjectionGeneration,
  type FieldProjectionGeneration
} from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "../../../shared/field-hash.js";
import { createProjectionGenerationReceipt } from "../../../recall/field/retrieval/projection/generation-identity.js";
import {
  activateProjectionGeneration,
  verifyProjectionGeneration,
  type ProjectionGenerationLifecycleStore
} from "../../../recall/field/retrieval/projection/generation-lifecycle.js";

function currentGeneration() {
  return createProjectionGenerationReceipt({
    workspace_id: "workspace-1", input_event_frontier: "source-frontier",
    governance_frontier: "governance-frontier", status: "shadow",
    recorded_at: "2026-09-08T00:00:00.000Z"
  }, fieldContractSha256);
}

function historicalGeneration(): FieldProjectionGeneration {
  const current = currentGeneration();
  const digest = fieldOperatorManifestDigest(fieldContractSha256);
  const identity = hashGenerationId({
    operators: FIELD_OPERATOR_MANIFEST, operator_manifest_digest: digest,
    field_schema_version: current.field_schema_version,
    input_event_frontier: current.input_event_frontier,
    governance_frontier: current.governance_frontier
  }, fieldContractSha256);
  return {
    ...current, identity, generation_id: identity,
    producer: PROJECTION_GENERATION_OPERATOR_ID, consumer: "activation",
    operator_manifest_digest: digest,
    operator_versions: FIELD_OPERATOR_MANIFEST.map(({ id, version }) => [id, version] as [string, string])
  };
}

function generationStore(receipt: FieldProjectionGeneration) {
  return {
    snapshot: vi.fn((input: FieldProjectionGeneration) => input),
    verify: vi.fn((input: FieldProjectionGeneration) => ({ ...input, status: "verified" as const })),
    activatePointer: vi.fn((input) => input),
    readGeneration: vi.fn(() => receipt)
  } satisfies ProjectionGenerationLifecycleStore;
}

describe("conditional source frontier generation authority", () => {
  it("creates only the current source and governance manifest", () => {
    const current = currentGeneration();
    expect(current.producer).toBe(CONDITIONAL_FIELD_GENERATION_OPERATOR_ID);
    expect(current.consumer).toBe("conditional_field_snapshot");
    expect(JSON.stringify(current.operator_versions)).not.toMatch(/select_gamma|query_condition|coverage_atoms/);
    expect(verifyFieldProjectionGeneration(current, fieldContractSha256)).toEqual(current);
    expect(current.generation_id).not.toBe(historicalGeneration().generation_id);
  });

  it("reads a historical receipt but refuses to approve it in the new lifecycle", () => {
    const old = historicalGeneration();
    expect(verifyFieldProjectionGeneration(old, fieldContractSha256)).toEqual(old);
    const store = generationStore(old);
    expect(() => verifyProjectionGeneration(store, old, fieldContractSha256))
      .toThrow("cannot approve a historical projection manifest");
    expect(store.verify).not.toHaveBeenCalled();
    expect(() => activateProjectionGeneration(store, {
      workspace_id: old.workspace_id, active_generation_id: old.generation_id, activated_at: old.recorded_at
    }, fieldContractSha256)).toThrow("cannot approve a historical projection manifest");
    expect(store.activatePointer).not.toHaveBeenCalled();
  });

  it("rejects a historical manifest disguised with a current producer header", () => {
    const disguised = { ...historicalGeneration(), producer: CONDITIONAL_FIELD_GENERATION_OPERATOR_ID, consumer: "conditional_field_snapshot" };
    expect(() => verifyFieldProjectionGeneration(disguised, fieldContractSha256)).toThrow(/producer or consumer/);
  });
});
