import { describe, expect, it } from "vitest";
import {
  buildGardenTurnEvidenceFallback,
  buildGardenTurnEvidenceArtifactRef,
  isGardenTurnEvidenceFallback
} from "@do-soul/alaya-soul";

const CREATED_AT = "2026-07-21T12:00:00.000Z";

describe("Garden turn evidence fallback", () => {
  it("builds a strict evidence-only source-turn envelope", () => {
    const signal = buildFallback("  User: ok thanks  ", "empty_extraction");

    expect(signal).toMatchObject({
      signal_id: "fallback-1",
      source: "garden_compile",
      signal_kind: "potential_evidence_anchor",
      object_kind: "source_turn",
      evidence_refs: [],
      raw_payload: {
        full_turn_content: "User: ok thanks",
        evidence_preservation: {
          reason: "empty_extraction",
          truncated: false,
          chars_clipped: 0
        }
      }
    });
    expect(isGardenTurnEvidenceFallback(signal!)).toBe(true);
    expect(buildGardenTurnEvidenceArtifactRef(signal!.signal_id))
      .toBe("alaya:garden-turn-evidence:fallback-1");
  });

  it("bounds the serialized raw payload even when escaping expands the source", () => {
    const source = `${"\\\"\n".repeat(8_000)}tail`;
    const signal = buildFallback(source, "no_evidence_created");
    const preservation = signal?.raw_payload.evidence_preservation as Record<string, unknown>;

    expect(JSON.stringify(signal?.raw_payload).length).toBeLessThanOrEqual(16_384);
    expect(preservation.truncated).toBe(true);
    expect(preservation.chars_clipped).toBeGreaterThan(0);
  });

  it("rejects a lookalike anchor that carries claimed evidence authority", () => {
    const signal = buildFallback("User: source turn", "empty_extraction")!;

    expect(isGardenTurnEvidenceFallback({ ...signal, evidence_refs: ["model-claim"] }))
      .toBe(false);
    expect(isGardenTurnEvidenceFallback({
      ...signal,
      raw_payload: { full_turn_content: "User: source turn" }
    })).toBe(false);
  });
});

function buildFallback(
  turnContent: string,
  reason: "empty_extraction" | "no_evidence_created"
) {
  return buildGardenTurnEvidenceFallback({
    turnContent,
    reason,
    signalId: "fallback-1",
    workspaceId: "workspace-1",
    runId: "run-1",
    surfaceId: null,
    createdAt: CREATED_AT,
    sourceObservation: null
  });
}
