import { describe, expect, it } from "vitest";
import {
  buildGardenTurnEvidenceFallback,
  buildGardenTurnEvidenceArtifactRef,
  isGardenTurnEvidenceFallback
} from "@do-soul/alaya-soul";
import { buildEvidenceInput } from
  "../../garden/materialization-router/inputs.js";

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
          chars_clipped: 0,
          source_receipt_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
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
    expect(isGardenTurnEvidenceFallback(signal!)).toBe(true);
    expect(preservation.truncated).toBe(true);
    expect(preservation.chars_clipped).toBeGreaterThan(0);
  });

  it("preserves a receipt-bound trailing newline through evidence materialization", () => {
    const signal = buildFallback(
      `${"line\n".repeat(20_000)}tail`,
      "empty_extraction"
    )!;
    const sourceCorpus = signal.raw_payload.full_turn_content as string;
    const preservation = signal.raw_payload.evidence_preservation as
      Record<string, unknown>;
    const evidence = buildEvidenceInput(signal, undefined, {
      fullTurnExcerpt: true,
      artifactRef: buildGardenTurnEvidenceArtifactRef(signal.signal_id)
    });

    expect(sourceCorpus.endsWith("\n")).toBe(true);
    expect(sourceCorpus.length + Number(preservation.chars_clipped))
      .toBe(`${"line\n".repeat(20_000)}tail`.length);
    expect(evidence).toMatchObject({
      evidence_kind: "conversation_excerpt",
      evidence_health_state: "verified",
      gist: sourceCorpus,
      excerpt: sourceCorpus,
      source_hash: expect.stringMatching(
        /^sha256:garden-source-turn-fallback-v1:[a-f0-9]{64}$/u
      )
    });
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

  it("rejects a copied receipt after source or identity mutation", () => {
    const signal = buildFallback("Assistant: exact prior answer", "empty_extraction")!;

    expect(isGardenTurnEvidenceFallback({
      ...signal,
      raw_payload: {
        ...signal.raw_payload,
        full_turn_content: "Assistant: invented replacement"
      }
    })).toBe(false);
    expect(isGardenTurnEvidenceFallback({
      ...signal,
      workspace_id: "other-workspace"
    })).toBe(false);
  });

  it("survives legitimate triage state transitions but not deferred ones", () => {
    const signal = buildFallback("User: exact source turn", "empty_extraction")!;

    expect(isGardenTurnEvidenceFallback({
      ...signal,
      signal_state: "compiled"
    })).toBe(true);
    expect(isGardenTurnEvidenceFallback({
      ...signal,
      signal_state: "deferred"
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
