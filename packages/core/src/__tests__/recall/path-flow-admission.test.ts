import { afterEach, describe, expect, it } from "vitest";
import type { RecallPolicy } from "@do-soul/alaya-protocol";
import { createCoarseCandidateAdder } from "../../recall/coarse-filter-admission.js";
import type { CoarseCandidateDraft } from "../../recall/coarse-candidates.js";
import { createMemoryEntry } from "./recall-service-test-fixtures.js";

const OBJ = "00000000-0000-4000-8000-0000000000d4";

afterEach(() => {
  delete process.env.ALAYA_RECALL_PATH_FLOW;
  delete process.env.ALAYA_RECALL_FLAT_BASELINE;
});

function makeAdder(): {
  readonly add: ReturnType<typeof createCoarseCandidateAdder>;
  readonly pathExpansionScores: Map<string, number>;
  readonly structuralScores: Map<string, number>;
} {
  const pathExpansionScores = new Map<string, number>();
  const structuralScores = new Map<string, number>();
  const add = createCoarseCandidateAdder({
    drafts: new Map<string, CoarseCandidateDraft>(),
    structuralScores,
    graphExpansionScores: new Map<string, number>(),
    entitySeedScores: new Map<string, number>(),
    pathExpansionScores,
    sourceProximityScores: new Map<string, number>(),
    winnerMemoryIds: new Set<string>([OBJ]),
    config: {} as RecallPolicy["coarse_filter"]
  });
  return { add, pathExpansionScores, structuralScores };
}

function admitPathExpansion(
  add: ReturnType<typeof createCoarseCandidateAdder>,
  edgeStrength: number,
  pathFlowScore: number
): void {
  add(
    createMemoryEntry({ object_id: OBJ, content: "path target", surface_id: null }),
    "path_expansion",
    edgeStrength,
    "path_expansion",
    undefined,
    undefined,
    false,
    pathFlowScore
  );
}

describe("path-axis real flow admission (V3)", () => {
  it("flat-baseline keeps the edge-strength max and ignores the flow value", () => {
    process.env.ALAYA_RECALL_FLAT_BASELINE = "1";
    const { add, pathExpansionScores } = makeAdder();
    admitPathExpansion(add, 0.5, 0.3);
    admitPathExpansion(add, 0.4, 0.9);
    expect(pathExpansionScores.get(OBJ)).toBeCloseTo(0.5, 9);
  });

  it("flag ON accumulates seed·edge flow across corroborating paths, clamped to 1", () => {
    process.env.ALAYA_RECALL_PATH_FLOW = "1";
    const { add, pathExpansionScores } = makeAdder();
    admitPathExpansion(add, 0.5, 0.3);
    admitPathExpansion(add, 0.5, 0.4);
    expect(pathExpansionScores.get(OBJ)).toBeCloseTo(0.7, 9);
    admitPathExpansion(add, 0.5, 0.9);
    expect(pathExpansionScores.get(OBJ)).toBeCloseTo(1, 9);
  });

  it("flag ON leaves the object-axis structural score unpolluted by the flow", () => {
    process.env.ALAYA_RECALL_PATH_FLOW = "1";
    const { add, pathExpansionScores, structuralScores } = makeAdder();
    admitPathExpansion(add, 0.5, 0.3);
    admitPathExpansion(add, 0.5, 0.4);
    expect(pathExpansionScores.get(OBJ)).toBeCloseTo(0.7, 9);
    expect(structuralScores.get(OBJ)).toBeCloseTo(0.5, 9);
  });

  it("four-axis default routes path_expansion to accumulated flow", () => {
    const { add, pathExpansionScores } = makeAdder();
    admitPathExpansion(add, 0.5, 0.3);
    admitPathExpansion(add, 0.5, 0.4);
    expect(pathExpansionScores.get(OBJ)).toBeCloseTo(0.7, 9);
  });
});
