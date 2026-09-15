import { describe, expect, it, vi } from "vitest";
import {
  BoundSourceInterpretationSchema,
  CandidateMemorySignalSchema,
  SOURCE_INTERPRETATION_CONTRACT,
  type SourceInterpretationSignal
} from "@do-soul/alaya-protocol";
import { MaterializationRouter } from "@do-soul/alaya-soul";
import { buildClaimInput, buildMemoryInput } from "../../../garden/materialization/materialization-router/inputs.js";
import { createDeps, createSignal } from "./materialization-router-fixture.js";

const located = {
  contract: SOURCE_INTERPRETATION_CONTRACT,
  artifact_key: "artifact-1",
  source_corpus_digest: "a".repeat(64),
  assertion_binding: {
    assertion_id: 1, source_span: [0, 12] as const, text: "A sent mail.", context_id: "context-1"
  },
  outcome: "empty" as const,
  candidates: [],
  diagnostics: []
};

function interpretationSignal(): SourceInterpretationSignal {
  const parsed = CandidateMemorySignalSchema.parse({
    signal_id: "observation-1",
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    source: "garden_compile",
    signal_kind: "potential_semantic_observation",
    interpretation_contract: SOURCE_INTERPRETATION_CONTRACT,
    object_kind: null,
    confidence: null,
    scope_hint: "project",
    domain_tags: [],
    evidence_refs: [],
    source_memory_refs: [],
    supersedes_refs: [],
    exception_to_refs: [],
    contradicts_refs: [],
    incompatible_with_refs: [],
    raw_payload: { source_interpretation: located },
    source_observation: {
      observed_at: "2026-09-14T00:00:00.000Z",
      authority: "trusted_host_event",
      source_event_id: "event-1"
    },
    created_at: "2026-09-14T00:00:00.000Z"
  });
  if (parsed.interpretation_contract === undefined) {
    throw new Error("expected source interpretation signal");
  }
  return parsed;
}

describe("MaterializationRouter source observation routing", () => {
  it("defers interpretation signals until the Core publication port is wired", async () => {
    const router = new MaterializationRouter(createDeps());
    const signal = interpretationSignal();
    expect(router.route(signal)).toMatchObject({
      kind: "deferred",
      routing_reason: "source observation admission is not connected"
    });
    const result = await router.materializeSignal(signal);
    expect(result).toMatchObject({
      success: true,
      target_kind: "deferred",
      created_objects: []
    });
  });

  it("publishes through the wired Core port and does not use legacy memory or claim writes", async () => {
    const deps = createDeps();
    const publish = vi.fn(async () => ({
      bound: BoundSourceInterpretationSchema.parse({
        ...located,
        source_target: {
          kind: "source_evidence",
          workspace_id: "workspace-1",
          root_kind: "source_record",
          root_id: "sha256:" + "b".repeat(64),
          source_version: "1",
          content_digest: "sha256:" + "c".repeat(64),
          evidence_object_id: "evidence-obs-1"
        }
      }),
      evidence: { object_kind: "evidence_capsule", object_id: "evidence-obs-1" },
      memory: { object_kind: "memory_entry", object_id: "memory-obs-1" }
    }));
    const router = new MaterializationRouter({ ...deps, sourceObservationPublicationPort: { publish } });
    const signal = interpretationSignal();
    expect(router.route(signal).route_target).toBe("memory_entry_only");
    const result = await router.materializeSignal(signal);
    expect(result).toMatchObject({
      success: true,
      route_target: "memory_entry_only",
      routing_reason: expect.stringContaining("empty"),
      created_objects: [
        { object_kind: "evidence_capsule", object_id: "evidence-obs-1" },
        { object_kind: "memory_entry", object_id: "memory-obs-1" }
      ]
    });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(deps.memoryService.create).not.toHaveBeenCalled();
    expect(deps.claimService.create).not.toHaveBeenCalled();
    expect(deps.evidenceService.create).not.toHaveBeenCalled();
  });

  it("keeps explicit claim materialization and rejects interpretation on legacy memory/claim builders", async () => {
    const deps = createDeps();
    const router = new MaterializationRouter(deps);
    const claimResult = await router.materializeSignal(createSignal({
      object_kind: "decision",
      signal_kind: "potential_claim",
      confidence: 0.9
    }));
    expect(claimResult.success).toBe(true);
    expect(deps.claimService.create).toHaveBeenCalledTimes(1);
    const signal = interpretationSignal();
    expect(() => buildMemoryInput(signal, [])).toThrow(/source observation requires its own memory admission/);
    expect(() => buildClaimInput(signal, [], [])).toThrow(/source interpretation cannot create a claim/);
  });

  it("surfaces evidence created_objects when memory write fails after capsule create", async () => {
    const deps = createDeps();
    const publish = vi.fn(async () => {
      const error = new Error("source observation memory write interrupted after evidence creation");
      (error as Error & { details: { evidence_object_id: string } }).details = {
        evidence_object_id: "evidence-obs-1"
      };
      throw error;
    });
    const router = new MaterializationRouter({ ...deps, sourceObservationPublicationPort: { publish } });
    const result = await router.materializeSignal(interpretationSignal());
    expect(result.success).toBe(false);
    expect(result.created_objects).toEqual([
      { object_kind: "evidence_capsule", object_id: "evidence-obs-1" }
    ]);
    expect(deps.memoryService.create).not.toHaveBeenCalled();
  });
});
