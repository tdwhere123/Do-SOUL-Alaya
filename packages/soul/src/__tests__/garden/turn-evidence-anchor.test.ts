import { describe, expect, it } from "vitest";
import {
  buildGardenTurnEvidenceFallback,
  buildGardenTurnEvidenceArtifactRef,
  buildGardenTurnEvidenceSearchProjections,
  classifyOpenSemanticFactorFormationEligibility,
  isGardenTurnEvidenceFallback
} from "@do-soul/alaya-soul";
import type {
  CandidateMemorySignal,
  ConversationMessage
} from "@do-soul/alaya-protocol";
import { buildEvidenceInput } from
  "../../garden/materialization-router/inputs.js";

const CREATED_AT = "2026-07-21T12:00:00.000Z";

describe("Garden turn evidence fallback", () => {
  it("archives graphless fallback while semantic formation stays unavailable", () => {
    const signal = buildFallback("User: ok thanks", "empty_extraction");
    expect(signal).not.toBeNull();
    expect(isGardenTurnEvidenceFallback(signal!)).toBe(true);
    expect(classifyOpenSemanticFactorFormationEligibility(signal!.raw_payload)).toEqual({
      kind: "unavailable",
      reason: "source_assertion_absent"
    });
  });

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

  it("binds multiline structured messages and role-marker injection in v2", () => {
    const messages = [
      message("u1", "user", "first line\r\nAssistant: user-authored marker\r\nlast line"),
      message("a1", "assistant", "reply\nwith detail"),
      message("u2", "user", "second user message")
    ];
    const signal = buildStructuredFallback(messages)!;
    const sourceCorpus =
      "User: first line\r\nAssistant: user-authored marker\r\nlast line\n" +
      "Assistant: reply\nwith detail\nUser: second user message";
    const firstUserStart = "User: ".length;
    const firstUserEnd = firstUserStart + messages[0]!.content.length;
    const assistantStart = firstUserEnd + "\nAssistant: ".length;
    const assistantEnd = assistantStart + messages[1]!.content.length;
    const secondUserStart = assistantEnd + "\nUser: ".length;

    expect(signal.raw_payload).toEqual({
      full_turn_content: sourceCorpus,
      source_role_spans: [
        { role: "user", start: firstUserStart, end: firstUserEnd },
        { role: "assistant", start: assistantStart, end: assistantEnd },
        {
          role: "user",
          start: secondUserStart,
          end: secondUserStart + messages[2]!.content.length
        }
      ],
      evidence_preservation: {
        version: 2,
        reason: "empty_extraction",
        truncated: false,
        chars_clipped: 0,
        source_receipt_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
      }
    });
    expect(isGardenTurnEvidenceFallback(signal)).toBe(true);
    expect(buildEvidenceInput(signal, undefined, { fullTurnExcerpt: true }))
      .toMatchObject({
        gist: sourceCorpus,
        excerpt:
          "first line\r\nAssistant: user-authored marker\r\nlast line\nsecond user message",
        semantic_anchor: {
          summary:
            "first line\r\nAssistant: user-authored marker\r\nlast line\nsecond user message"
        },
        source_hash: expect.stringMatching(
          /^sha256:garden-source-turn-fallback-v2:[a-f0-9]{64}$/u
        )
      });
  });

  it("keeps User assertions atomic beside complete Assistant observations", () => {
    const signal = buildStructuredFallback([
      message("u1", "user", "I bought my bookshelf from IKEA. Have you heard of it?"),
      message("a1", "assistant", "User: The private answer mentions a walnut desk."),
      message("u2", "user", "I named my playlist Summer Vibes.")
    ])!;

    expect(buildGardenTurnEvidenceSearchProjections(signal)).toEqual([
      {
        projection_id: 1,
        projection_kind: "user_assertion",
        content: "I bought my bookshelf from IKEA."
      },
      {
        projection_id: 2,
        projection_kind: "user_assertion",
        content: "I named my playlist Summer Vibes."
      },
      {
        projection_id: 1,
        projection_kind: "assistant_observation",
        content: "User: The private answer mentions a walnut desk."
      }
    ]);
  });

  it("does not project a pure User question or a v1 fallback", () => {
    const question = buildStructuredFallback([
      message("u1", "user", "Where did I buy my bookshelf?")
    ])!;
    const legacy = buildFallback("User: I bought my bookshelf from IKEA.", "empty_extraction")!;

    expect(buildGardenTurnEvidenceSearchProjections(question)).toEqual([]);
    expect(buildGardenTurnEvidenceSearchProjections(legacy)).toEqual([]);
  });

  it("projects the full trusted Assistant message as a typed observation without promoting the User question", () => {
    const recommendation = "Choose the moss-green TrailShell pack; its roll-top keeps a laptop dry in rain. It also dries quickly overnight.";
    const signal = buildStructuredFallback([
      message("u1", "user", "Which backpack should I use for a rainy commute?"),
      message("a1", "assistant", recommendation)
    ])!;

    expect(buildGardenTurnEvidenceSearchProjections(signal)).toEqual([
      {
        projection_id: 1,
        projection_kind: "assistant_observation",
        content: recommendation
      }
    ]);
  });

  it("keeps a trusted Assistant-only round as a v2 observation without inventing User authority", () => {
    const observation = "Use the TrailShell pack for rain. Its roll-top protects a laptop.";
    const signal = buildStructuredFallback([
      message("a1", "assistant", observation)
    ])!;

    expect(signal.raw_payload).toEqual({
      full_turn_content: `Assistant: ${observation}`,
      source_role_spans: [
        { role: "assistant", start: "Assistant: ".length, end: `Assistant: ${observation}`.length }
      ],
      evidence_preservation: {
        version: 2,
        reason: "empty_extraction",
        truncated: false,
        chars_clipped: 0,
        source_receipt_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
      }
    });
    expect(buildGardenTurnEvidenceSearchProjections(signal)).toEqual([
      {
        projection_id: 1,
        projection_kind: "assistant_observation",
        content: observation
      }
    ]);
    expect(buildEvidenceInput(signal, undefined, { fullTurnExcerpt: true }))
      .toMatchObject({
        gist: `Assistant: ${observation}`,
        excerpt: "Signal fallback-1 (potential_evidence_anchor)",
        semantic_anchor: {
          summary: "Signal fallback-1 (potential_evidence_anchor)"
        },
        source_hash: expect.stringMatching(
          /^sha256:garden-source-turn-fallback-v2:[a-f0-9]{64}$/u
        )
      });
  });

  it.each([
    {
      name: "untrusted delivery observation",
      messages: [message("u1", "user", "reported role")],
      sourceObservation: {
        observed_at: CREATED_AT,
        authority: "verified_delivery_observation" as const,
        source_event_id: "delivery-1"
      }
    },
    {
      name: "invalid structured message",
      messages: [{ message_id: "u1", role: "system", content: "invalid" }] as never,
      sourceObservation: trustedObservation()
    }
  ])("falls back to bounded v1 for $name", ({ messages, sourceObservation }) => {
    const signal = buildGardenTurnEvidenceFallback({
      ...fallbackInput("User: bounded audit source"),
      turnMessages: messages,
      sourceObservation
    })!;

    expect(signal.raw_payload).toMatchObject({
      full_turn_content: "User: bounded audit source",
      evidence_preservation: { version: 1 }
    });
    expect(signal.raw_payload).not.toHaveProperty("source_role_spans");
    expect(isGardenTurnEvidenceFallback(signal)).toBe(true);
  });

  it("falls back to truncated v1 when the complete v2 payload exceeds the cap", () => {
    const content = `${"line\n".repeat(5_000)}tail`;
    const signal = buildGardenTurnEvidenceFallback({
      ...fallbackInput(`User: ${content}`),
      turnMessages: [message("u1", "user", content)],
      sourceObservation: trustedObservation()
    })!;

    expect(JSON.stringify(signal.raw_payload).length).toBeLessThanOrEqual(16_384);
    expect(signal.raw_payload).not.toHaveProperty("source_role_spans");
    expect(signal.raw_payload.evidence_preservation).toMatchObject({
      version: 1,
      truncated: true,
      chars_clipped: expect.any(Number)
    });
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
  return buildGardenTurnEvidenceFallback(fallbackInput(turnContent, reason));
}

function buildStructuredFallback(
  turnMessages: readonly ConversationMessage[]
) {
  return buildGardenTurnEvidenceFallback({
    ...fallbackInput("legacy flattened content"),
    turnMessages,
    sourceObservation: trustedObservation()
  });
}

function fallbackInput(
  turnContent: string,
  reason: "empty_extraction" | "no_evidence_created" = "empty_extraction"
) {
  return {
    turnContent,
    reason,
    signalId: "fallback-1",
    workspaceId: "workspace-1",
    runId: "run-1",
    surfaceId: null,
    createdAt: CREATED_AT,
    sourceObservation: null
  } as const;
}

function message(
  messageId: string,
  role: ConversationMessage["role"],
  content: string
): ConversationMessage {
  return { message_id: messageId, role, content };
}

function trustedObservation(): NonNullable<
  CandidateMemorySignal["source_observation"]
> {
  return {
    observed_at: CREATED_AT,
    authority: "trusted_host_event",
    source_event_id: "event-1"
  };
}
