import { describe, expect, it } from "vitest";
import {
  FACTOR_INCIDENCE_OPERATOR_ID,
  fieldReceiptContractFields,
  hashFactorId,
  hashIncidenceId,
  type FactorDescriptor,
  type FactorFamily,
  type FactorIncidence
} from "@do-soul/alaya-protocol";
import { fieldContractSha256 as fieldSha256 } from "../../../shared/field-hash.js";
import {
  createInMemoryFieldStores,
  type FieldFormationStores
} from "../../../memory/evidence-create/field-stores.js";
import { createSourceAdmissionPort } from "../../../memory/evidence-create/source-admission.js";
import {
  projectSourceFormationSnapshot,
  type SourceProjectionState
} from "../../../recall/field/retrieval/projection/source-projection.js";

const CLOCK = "2026-08-16T00:00:00.000Z";
const BODY = "Atlas notes.";
const EVIDENCE_ID = "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9";

describe("source formation projection", () => {
  it("omits empty canonical payloads and keeps a sibling factor", () => {
    const stores = createInMemoryFieldStores();
    const spanId = admitSource(stores).spans[0]!.identity;
    seedFactor(stores, spanId, "f1", "");
    seedFactor(stores, spanId, "f1", " \t");
    seedFactor(stores, spanId, "f1", "atlas");

    const snapshot = projectSourceFormationSnapshot({
      workspaceId: "workspace-1",
      stores,
      resolveState: () => sourceState()
    });

    expect(snapshot.slice_keys).toHaveLength(1);
    expect(snapshot.slice_keys[0]?.normalized_value).toBe("atlas");
    expect(snapshot.slice_keys[0]?.owner_id).toBe(EVIDENCE_ID);
  });
});

function admitSource(stores: FieldFormationStores) {
  return createSourceAdmissionPort({ sha256: fieldSha256, stores }).admit({
    workspace_id: "workspace-1",
    source_id: "src-1",
    source_version: "v1",
    content_bytes: BODY,
    evidence_object_id: EVIDENCE_ID,
    recorded_at: CLOCK,
    event_time: null,
    valid_from: null,
    valid_to: null,
    spans: [{ start_offset: 0, end_offset: BODY.length, purpose: "native_structure" }]
  });
}

function seedFactor(
  stores: FieldFormationStores,
  spanId: string,
  family: FactorFamily,
  payload: string
): void {
  const factor = descriptor(family, payload);
  stores.putDescriptor(factor);
  stores.putIncidence(incidence(spanId, factor.identity));
}

function descriptor(family: FactorFamily, payload: string): FactorDescriptor {
  const identity = hashFactorId({
    family,
    canonical_payload: payload,
    operator_id: FACTOR_INCIDENCE_OPERATOR_ID
  }, fieldSha256);
  return {
    ...fieldReceiptContractFields({
      identity,
      producer: FACTOR_INCIDENCE_OPERATOR_ID,
      consumer: "projection_generation"
    }),
    schema_version: 1,
    workspace_id: "workspace-1",
    family,
    canonical_payload: payload,
    operator_id: FACTOR_INCIDENCE_OPERATOR_ID,
    recorded_at: CLOCK
  };
}

function incidence(spanId: string, factorId: string): FactorIncidence {
  const identity = hashIncidenceId({
    span_id: spanId,
    factor_id: factorId,
    scope: "workspace-1",
    operator_id: FACTOR_INCIDENCE_OPERATOR_ID
  }, fieldSha256);
  return {
    ...fieldReceiptContractFields({
      identity,
      producer: FACTOR_INCIDENCE_OPERATOR_ID,
      consumer: "projection_generation"
    }),
    schema_version: 1,
    workspace_id: "workspace-1",
    span_id: spanId,
    factor_id: factorId,
    scope: "workspace-1",
    operator_id: FACTOR_INCIDENCE_OPERATOR_ID,
    recorded_at: CLOCK
  };
}

function sourceState(): SourceProjectionState {
  return {
    scope: "workspace-1",
    event_time: null,
    valid_from: null,
    valid_to: null,
    lifecycle_state: "active",
    governance_state: "ordinary_evidence",
    sealed: false,
    erased: false,
    revoked: false,
    governance_effects: []
  };
}
