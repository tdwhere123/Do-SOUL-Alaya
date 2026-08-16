import { describe, expect, it, vi } from "vitest";
import {
  FACTOR_INCIDENCE_OPERATOR_ID,
  OPEN_SEMANTIC_FACTOR_FORMATION_OPERATOR_ID,
  hashDerivationJobId,
  hashIncidenceId,
  type FactorIncidence
} from "@do-soul/alaya-protocol";
import type { OpenSemanticFactorExtractionPort } from
  "../../semantic/open-semantic-factor-extraction-port.js";
import { emitDeterministicIncidences } from "../../memory/evidence-create/factor-emit.js";
import { fieldSha256 } from "../../memory/evidence-create/field-hash.js";
import { createInMemoryFieldStores } from "../../memory/evidence-create/field-stores.js";
import {
  createFactorIncidencePort,
  nominateSemanticDerivationJob
} from "../../memory/evidence-create/factor-incidence.js";
import { createSourceAdmissionPort } from "../../memory/evidence-create/source-admission.js";

const CLOCK = "2026-08-16T00:00:00.000Z";
const BODY = "I use Atlas for research.";

describe("factor incidence", () => {
  it("emits F0-F2 incidences using Wave 0 identities", () => {
    const stores = createInMemoryFieldStores();
    const admission = createSourceAdmissionPort({ sha256: fieldSha256, stores });
    const incidence = createFactorIncidencePort({ sha256: fieldSha256, stores });
    const admitted = admission.admit({
      workspace_id: "workspace-1",
      source_id: "src-1",
      source_version: "v1",
      content_bytes: BODY,
      evidence_object_id: "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9",
      recorded_at: CLOCK,
      event_time: null,
      valid_from: null,
      valid_to: null,
      spans: [{ start_offset: 0, end_offset: BODY.length, purpose: "native_structure" }]
    });
    const emitted = emitDeterministicIncidences({
      sha256: fieldSha256,
      recorded_at: CLOCK,
      workspace_id: "workspace-1",
      scope: "workspace-1",
      source_id: "src-1",
      source_version: "v1",
      content_bytes: BODY,
      actor: "user_action",
      event_time: null,
      valid_from: null,
      valid_to: null,
      spans: admitted.spans,
      factFrameSlots: [{ text: "Atlas" }],
      semanticSurfaces: []
    });

    for (const factor of emitted.factors) {
      stores.putDescriptor(factor);
    }
    const recorded = emitted.incidences.map((row) => incidence.recordIncidence(row));
    const families = new Set(emitted.factors.map((factor) => factor.family));

    expect(families.has("f0")).toBe(true);
    expect(families.has("f1")).toBe(true);
    expect(families.has("f2")).toBe(true);
    expect(families.has("f3")).toBe(false);
    expect(recorded).toHaveLength(emitted.incidences.length);
    expect(recorded.every((row) => verifyIncidence(row))).toBe(true);
  });

  it("nominates at most one active F3 job and never calls a provider", () => {
    const stores = createInMemoryFieldStores();
    const incidence = createFactorIncidencePort({ sha256: fieldSha256, stores });
    const extractor = {
      operator_id: "structured_open_semantic_factor_v1",
      extract: vi.fn(async () => {
        throw new Error("provider must stay off the write path");
      })
    } satisfies OpenSemanticFactorExtractionPort;
    const first = nominateSemanticDerivationJob({
      sha256: fieldSha256,
      incidence,
      extractor,
      workspace_id: "workspace-1",
      evidence_object_id: "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9",
      recorded_at: CLOCK
    });
    const replay = nominateSemanticDerivationJob({
      sha256: fieldSha256,
      incidence,
      extractor,
      workspace_id: "workspace-1",
      evidence_object_id: "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9",
      recorded_at: CLOCK
    });

    expect(first?.status).toBe("nominated");
    expect(replay?.identity).toBe(first?.identity);
    expect(first?.identity).toBe(hashDerivationJobId({
      purpose: "f3_semantic",
      operator_id: OPEN_SEMANTIC_FACTOR_FORMATION_OPERATOR_ID,
      input_evidence_ids: ["85b3671a-d8d8-4848-9e5c-07d0a89f5ae9"]
    }, fieldSha256));
    expect(extractor.extract).not.toHaveBeenCalled();
  });
});

function verifyIncidence(row: FactorIncidence): boolean {
  return row.identity === hashIncidenceId(row, fieldSha256) &&
    row.operator_id === FACTOR_INCIDENCE_OPERATOR_ID;
}
