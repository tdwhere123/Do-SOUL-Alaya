import { expect, it, vi } from "vitest";
import { sourceSemanticCorrespondenceIdentity } from "@do-soul/alaya-protocol";
import { fieldContractSha256 as sha } from "../../../shared/field-hash.js";
import * as observation from "../../../recall/runtime/conditional-field-observe.js";
import { admitSourceSemanticCorrespondence } from "../../../recall/conditional-field/query/source-semantic-correspondence-admission.js";
import { deliveredSourceSemanticLibraryProof } from "../../../recall/runtime/source-semantic-library-proof.js";
import {
  checkSourceSemanticPositiveCertificate, type SourceSemanticPositiveCertificateTable
} from "../../../recall/runtime/source-semantic-positive-certificate.js";
import {
  executeSourceSemanticInterpretation, SOURCE_SEMANTIC_REASONING_BUDGET,
  type ReasonSourceSemanticInterpretationInput
} from "../../../recall/runtime/source-semantic-reasoning.js";
import { finiteSource, finiteQuery, finiteCorrespondence, FINITE_QUERY } from "./source-semantic-finite-fixture.js";
import {
  source, query, correspondenceFor, run, ORIGINAL, CLOCK, BUDGET, deliveredProofFixture
} from "./source-semantic-proof-fixture.js";

it("keeps option-absent result equal to the existing fixture", () => {
  const interpretation = source(), semantics = query(), correspondence = correspondenceFor(interpretation, semantics);
  const existing = run(interpretation, semantics, correspondence);
  const executed = executeSourceSemanticInterpretation({
    source_interpretation: interpretation, query_semantics: semantics, semantic_correspondence: correspondence,
    workspaceId: "ws", scope: "project", authorizedScopes: ["project"], asOf: CLOCK,
    request: { contract: "source-interpretation-reasoning-v5", accepts_unreviewed_conditional_results: true,
      source_interpretation_id: correspondence.source_interpretation_id, query_semantics_id: correspondence.query_semantics_id,
      semantic_correspondence_id: sourceSemanticCorrespondenceIdentity(correspondence, sha), original_query: ORIGINAL,
      budget: BUDGET, output_byte_limit: 1000000 }
  });
  expect(executed.result).toEqual(existing);
  expect(Buffer.byteLength(JSON.stringify(executed.result))).toBe(Buffer.byteLength(JSON.stringify(existing)));
  expect(executed.result.resource_usage).toEqual(existing.resource_usage);
  expect("positive_certificate" in executed).toBe(false);
});

it("verifies a supported relation+sequence fixture that replay accepts without observeField", () => {
  const { record, proof, index, entry, qualifier } = deliveredProofFixture();
  const replay = deliveredSourceSemanticLibraryProof(index, entry, qualifier, [proof], record);
  expect(replay.proof !== undefined).toBe(true);
  const observe = vi.spyOn(observation, "observeField");
  try {
    const checked = checkSourceSemanticPositiveCertificate(certificateInput(proof, record));
    expect(observe).not.toHaveBeenCalled();
    expect(checked.status).toBe(replay.proof !== undefined ? "verified" : "rejected");
    expect(checked.resource_usage.work_units).toBeGreaterThan(0);
    expect(checked.resource_usage.work_units).toBeLessThan(replay.resource_usage.work_units);
  } finally {
    observe.mockRestore();
  }
  const off = executeSourceSemanticInterpretation(executionInput());
  const on = executeSourceSemanticInterpretation({ ...executionInput(), record_positive_certificate: true });
  expect(on.result).toEqual(off.result);
  expect(on.result.resource_usage).toEqual(off.result.resource_usage);
  expect(on.positive_certificate?.status).toBe(replay.proof !== undefined ? "verified" : "rejected");
});

it("rejects a tampered relation+sequence answer", () => {
  const { record, proof, index, entry, qualifier } = deliveredProofFixture();
  const replay = deliveredSourceSemanticLibraryProof(index, entry, qualifier, [proof], record);
  expect(replay.proof !== undefined).toBe(true);
  const tampered = structuredClone(proof);
  const answer = tampered.binding_results?.[0];
  if (answer?.bindings.tools !== undefined) Object.assign(answer.bindings.tools, { node_id: "rY" });
  else throw new Error("fixture must expose a tools binding to tamper");
  const observe = vi.spyOn(observation, "observeField");
  try {
    const checked = checkSourceSemanticPositiveCertificate(certificateInput(tampered, record));
    expect(observe).not.toHaveBeenCalled();
    expect(checked.status).toBe("rejected");
  } finally {
    observe.mockRestore();
  }
});

it("returns unsupported for finite forall while replay may still verify", () => {
  const interpretation = finiteSource(), semantics = finiteQuery(true);
  const correspondence = finiteCorrespondence(interpretation, semantics);
  const budget = { ...SOURCE_SEMANTIC_REASONING_BUDGET, work_units: 10_000_000, memory_bytes: 60_000_000, finalization_reserve: 50_000 };
  const { record, proof, index, entry, qualifier } = deliveredProofFixture({
    interpretation, semantics, correspondence, original: FINITE_QUERY, library: true, budget
  });
  const replay = deliveredSourceSemanticLibraryProof(index, entry, qualifier, [proof], record, budget);
  const observe = vi.spyOn(observation, "observeField");
  try {
    const checked = checkSourceSemanticPositiveCertificate(certificateInput(proof, record, budget));
    expect(observe).not.toHaveBeenCalled();
    expect(checked.status).toBe("unsupported");
    expect(checked.status).not.toBe(replay.proof !== undefined ? "verified" : "rejected");
  } finally {
    observe.mockRestore();
  }
}, 60_000);

it("checks one fixed certificate without unnamed distractor fan-out and rejects an independent tamper", () => {
  const { record, proof } = deliveredProofFixture();
  const input = certificateInput(proof, record);
  const recorded = checkSourceSemanticPositiveCertificate(input);
  const table = recorded.certificate;
  if (table === undefined || table.steps.length === 0) {
    throw new Error("supported relation+sequence fixture must record used admitted steps");
  }
  const admitted = admitSourceSemanticCorrespondence({
    source_interpretation: proof.interpretation, query_semantics: proof.query,
    semantic_correspondence: proof.semantic_correspondence, original_query: proof.original_query
  });
  if (admitted.kind !== "admitted") throw new Error("fixture correspondence must be admitted");
  const few = unnamedDistractors(table, 16, admitted.interpretation_id, admitted.context_id);
  const many = unnamedDistractors(table, 128, admitted.interpretation_id, admitted.context_id);
  const searchFew = checkSourceSemanticPositiveCertificate(input, { extra_adjacency: few });
  const searchMany = checkSourceSemanticPositiveCertificate(input, { extra_adjacency: many });
  expect(searchMany.resource_usage.work_units).toBeGreaterThan(searchFew.resource_usage.work_units);
  const expectedIntact = "verified" as const;
  const expectedTamper = "rejected" as const;
  const tampered = {
    ...table,
    steps: table.steps.map((step, index) => index === 0 ? { ...step, milligrades: step.milligrades + 1 } : step)
  };
  const intactFew = checkSourceSemanticPositiveCertificate({ ...input, certificate: table }, { extra_adjacency: few });
  const intactMany = checkSourceSemanticPositiveCertificate({ ...input, certificate: table }, { extra_adjacency: many });
  expect(intactFew.status).toBe(expectedIntact);
  expect(intactMany.status).toBe(expectedIntact);
  expect(intactFew.resource_usage.work_units).toBeGreaterThan(0);
  expect(intactMany.resource_usage.work_units).toBe(intactFew.resource_usage.work_units);
  expect(intactMany.resource_usage.memory_bytes).toBe(intactFew.resource_usage.memory_bytes);
  const tamperMany = checkSourceSemanticPositiveCertificate(
    { ...input, certificate: tampered }, { extra_adjacency: many });
  expect(tamperMany.status).toBe(expectedTamper);
});

function executionInput(): ReasonSourceSemanticInterpretationInput {
  const interpretation = source(), semantics = query(), correspondence = correspondenceFor(interpretation, semantics);
  return {
    source_interpretation: interpretation, query_semantics: semantics, semantic_correspondence: correspondence,
    workspaceId: "ws", scope: "project", authorizedScopes: ["project"], asOf: CLOCK,
    request: { contract: "source-interpretation-reasoning-v5", accepts_unreviewed_conditional_results: true,
      source_interpretation_id: correspondence.source_interpretation_id, query_semantics_id: correspondence.query_semantics_id,
      semantic_correspondence_id: sourceSemanticCorrespondenceIdentity(correspondence, sha), original_query: ORIGINAL,
      budget: BUDGET, output_byte_limit: 1_000_000 }
  };
}

function certificateInput(
  proof: ReturnType<typeof deliveredProofFixture>["proof"],
  record: ReturnType<typeof deliveredProofFixture>["record"],
  budget = SOURCE_SEMANTIC_REASONING_BUDGET
) {
  return {
    source_interpretation: proof.interpretation, query_semantics: proof.query,
    semantic_correspondence: proof.semantic_correspondence, original_query: proof.original_query,
    workspaceId: record.workspace_id, scope: record.scope_class ?? "project", authorizedScopes: ["project"] as const,
    asOf: CLOCK, sourceValidity: record, source_target: proof.source_target, claimed: proof, budget
  };
}

function unnamedDistractors(
  table: SourceSemanticPositiveCertificateTable, count: number, packetId: string, hypothesisId: string
) {
  const template = table.steps[0];
  if (template === undefined) throw new Error("certificate must name at least one admitted row");
  return Array.from({ length: count }, (_, index) => ({
    assertionId: `distractor/${String(index).padStart(6, "0")}`,
    sourceObjectId: template.source_object_id,
    targetObjectId: `distractor-target-${index}`,
    resultObjectId: `distractor-target-${index}`,
    predicate: template.predicate,
    validity: { kind: "interpretation" as const, packet_id: packetId, hypothesis_id: hypothesisId },
    interpretation_source: { packet_id: packetId, hypothesis_id: hypothesisId, node_id: `d-src-${index}` },
    interpretation_target: { packet_id: packetId, hypothesis_id: hypothesisId, node_id: `d-tgt-${index}` },
    source_revision: packetId
  }));
}
