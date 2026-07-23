import { describe, expect, it } from "vitest";

import { buildEvidenceInput } from "../../garden/materialization-router/inputs.js";
import { createSignal } from "./materialization-router-fixture.js";

describe("buildEvidenceInput fullTurnExcerpt", () => {
  const FULL_TURN =
    "User: Can you recommend video editing resources? I use Adobe Premiere Pro and want advanced color grading tutorials.";

  it("default: excerpt/gist = the narrow signal summary (unchanged)", () => {
    const signal = createSignal({
      raw_payload: { excerpt: "prefers Adobe Premiere Pro", full_turn_content: FULL_TURN }
    });
    const ev = buildEvidenceInput(signal);
    expect(ev.excerpt).toBe("prefers Adobe Premiere Pro");
    expect(ev.gist).toBe("prefers Adobe Premiere Pro");
  });

  it("fullTurnExcerpt: widens excerpt/gist to full_turn_content", () => {
    const signal = createSignal({
      raw_payload: { excerpt: "prefers Adobe Premiere Pro", full_turn_content: FULL_TURN }
    });
    const ev = buildEvidenceInput(signal, undefined, { fullTurnExcerpt: true });
    expect(ev.excerpt).toBe(FULL_TURN);
    expect(ev.gist).toBe(FULL_TURN);
  });

  it("fullTurnExcerpt: ignores bench_full_turn_content and falls back to summary", () => {
    const benchOnly = createSignal({
      raw_payload: { excerpt: "narrow", bench_full_turn_content: FULL_TURN }
    });
    expect(buildEvidenceInput(benchOnly, undefined, { fullTurnExcerpt: true }).excerpt).toBe("narrow");

    const noTurn = createSignal({ raw_payload: { excerpt: "narrow only" } });
    expect(buildEvidenceInput(noTurn, undefined, { fullTurnExcerpt: true }).excerpt).toBe("narrow only");
  });

  it("never substitutes signal creation time for a source observation", () => {
    const evidence = buildEvidenceInput(createSignal({
      created_at: "2020-01-01T00:00:00.000Z"
    }));

    expect(evidence.event_anchor).toBeNull();
  });

  it("uses only the verified EventLog context for a temporal evidence anchor", () => {
    const evidence = buildEvidenceInput(createSignal(), undefined, {
      context: {
        source_event_anchor: {
          event_type: "soul.signal.emitted",
          event_id: "event-1",
          occurred_at: "2019-12-31T23:59:59.000Z"
        }
      }
    });

    expect(evidence.event_anchor).toEqual({
      event_type: "soul.signal.emitted",
      event_id: "event-1",
      occurred_at: "2019-12-31T23:59:59.000Z"
    });
  });

  it("persists a verified User assertion receipt from the production grounding path", () => {
    const signal = createGroundedGardenSignal();
    const evidence = buildEvidenceInput(signal, undefined, { fullTurnExcerpt: true });

    expect(evidence).toMatchObject({
      created_by: "garden_compile",
      evidence_kind: "conversation_excerpt",
      evidence_health_state: "verified",
      gist: signal.raw_payload.full_turn_content
    });
    expect(evidence.source_hash)
      .toMatch(/^sha256:garden-verified-user-assertion-v1:[a-f0-9]{64}$/u);
  });

  it("does not mint a receipt from a rejected or locator-free Garden payload", () => {
    const grounded = createGroundedGardenSignal();
    const { source_locator: _sourceLocator, ...withoutLocator } = grounded.raw_payload;
    const evidence = buildEvidenceInput(createSignal({
      ...grounded,
      raw_payload: withoutLocator
    }), undefined, { fullTurnExcerpt: true });

    expect(evidence.source_hash).toBeNull();
    expect(evidence.evidence_health_state).toBe("questionable");
    expect(evidence.evidence_kind).toBe("inferred");
  });

  it("does not mint a receipt from contradictory audit fields or a derived gist", () => {
    const grounded = createGroundedGardenSignal();
    const contradictory = buildEvidenceInput(createSignal({
      ...grounded,
      raw_payload: {
        ...grounded.raw_payload,
        source_grounding: {
          ...grounded.raw_payload.source_grounding as Record<string, unknown>,
          source_assertion: "I bought my bookshelf from Target."
        }
      }
    }), undefined, { fullTurnExcerpt: true });
    const derived = buildEvidenceInput(grounded, "derived", { fullTurnExcerpt: true });

    expect(contradictory).toMatchObject({
      source_hash: null,
      evidence_health_state: "questionable",
      evidence_kind: "inferred"
    });
    expect(derived.source_hash).toBeNull();
  });
});

function createGroundedGardenSignal() {
  const assertion = "I bought my bookshelf from IKEA.";
  const sourceCorpus = `User: ${assertion}`;
  return createSignal({
    source: "garden_compile",
    object_kind: "fact",
    evidence_refs: [],
    raw_payload: {
      matched_text: assertion,
      distilled_fact: assertion,
      proposed_matched_text: assertion,
      source_assertion: assertion,
      source_locator: {
        contract_version: 2,
        kind: "assertion_catalog",
        assertion_id: 1
      },
      source_grounding: {
        version: 1,
        status: "grounded",
        content_basis: "source_assertion",
        source_assertion: assertion,
        proposed_matched_text: assertion,
        reasons: []
      },
      full_turn_content: sourceCorpus
    }
  });
}
