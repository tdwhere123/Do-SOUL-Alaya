import { createHash } from "node:crypto";
import {
  buildVerifiedUserAssertionReceiptV2Preimage,
  formatVerifiedUserAssertionV2SourceHash
} from "@do-soul/alaya-protocol";
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

  it("preserves an exact gist when the ordinary evidence excerpt is null", () => {
    const gist = "  用户在上海确认了发布 🚀  ";
    const evidence = buildEvidenceInput(createSignal({
      raw_payload: { excerpt: null, gist }
    }), undefined, { fullTurnExcerpt: true });

    expect(evidence.gist).toBe(gist);
    expect(evidence.excerpt).toBe(gist);
    expect(evidence.semantic_anchor.summary).toBe(gist);
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

  it("keeps a verified receipt corpus in gist while preserving each grounded assertion as the excerpt", () => {
    const firstAssertion = "I bought my bookshelf from IKEA.";
    const secondAssertion = "I prefer warm light in the bedroom.";
    const sourceCorpus = `User: ${firstAssertion} ${secondAssertion}`;
    const firstSignal = createGroundedGardenSignal(firstAssertion, sourceCorpus, 1);
    const secondSignal = createGroundedGardenSignal(secondAssertion, sourceCorpus, 2);
    const firstEvidence = buildEvidenceInput(firstSignal, undefined, { fullTurnExcerpt: true });
    const secondEvidence = buildEvidenceInput(secondSignal, undefined, { fullTurnExcerpt: true });

    for (const [assertion, evidence, assertionId] of [
      [firstAssertion, firstEvidence, 1],
      [secondAssertion, secondEvidence, 2]
    ] as const) {
      expect(evidence).toMatchObject({
        created_by: "garden_compile",
        evidence_kind: "conversation_excerpt",
        evidence_health_state: "verified",
        gist: sourceCorpus,
        excerpt: assertion,
        semantic_anchor: { summary: assertion },
        source_hash: expectedSourceHash(assertion, sourceCorpus, assertionId)
      });
    }
    expect(firstEvidence.excerpt).not.toBe(secondEvidence.excerpt);
    expect(firstEvidence.semantic_anchor.summary).not.toBe(secondEvidence.semantic_anchor.summary);
  });

  it("keeps the verified assertion authoritative over a divergent schema projection", () => {
    const assertion = "I bought my bookshelf from IKEA.";
    const grounded = createGroundedGardenSignal(assertion);
    const evidence = buildEvidenceInput(createSignal({
      ...grounded,
      raw_payload: {
        ...grounded.raw_payload,
        field_candidates: [{
          field_name: "content",
          value: "A different schema projection.",
          evidence: assertion,
          confidence: 1
        }]
      }
    }), undefined, { fullTurnExcerpt: true });

    expect(evidence).toMatchObject({
      excerpt: assertion,
      semantic_anchor: { summary: assertion }
    });
  });

  it("does not mint a receipt during materialization or from a locator-free payload", () => {
    const grounded = createGroundedGardenSignal();
    const {
      verified_user_assertion_source_hash: _sourceHash,
      ...withoutProducerReceipt
    } = grounded.raw_payload;
    const unreceipted = buildEvidenceInput(createSignal({
      ...grounded,
      raw_payload: withoutProducerReceipt
    }), undefined, { fullTurnExcerpt: true });
    const { source_locator: _sourceLocator, ...withoutLocator } = grounded.raw_payload;
    const locatorFree = buildEvidenceInput(createSignal({
      ...grounded,
      raw_payload: withoutLocator
    }), undefined, { fullTurnExcerpt: true });

    for (const evidence of [unreceipted, locatorFree]) {
      expect(evidence.source_hash).toBeNull();
      expect(evidence.evidence_health_state).toBe("questionable");
      expect(evidence.evidence_kind).toBe("inferred");
    }
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
    expect(derived).toMatchObject({
      source_hash: null,
      excerpt: grounded.raw_payload.full_turn_content,
      gist: `${grounded.raw_payload.full_turn_content} derived`
    });
  });
});

function createGroundedGardenSignal(
  assertion = "I bought my bookshelf from IKEA.",
  sourceCorpus = `User: ${assertion}`,
  assertionId = 1
) {
  return createSignal({
    source: "garden_compile",
    object_kind: "fact",
    evidence_refs: [],
    raw_payload: {
      matched_text: assertion,
      distilled_fact: assertion,
      proposed_matched_text: assertion,
      source_assertion: assertion,
      verified_user_assertion_source_hash:
        expectedSourceHash(assertion, sourceCorpus, assertionId),
      source_locator: {
        contract_version: 2,
        kind: "assertion_catalog",
        assertion_id: assertionId
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

function expectedSourceHash(
  sourceAssertion: string,
  sourceCorpus: string,
  assertionId: number
): string {
  const digest = createHash("sha256")
    .update(buildVerifiedUserAssertionReceiptV2Preimage({
      signal_id: "signal-1",
      source_locator: {
        contract_version: 2,
        kind: "assertion_catalog",
        assertion_id: assertionId
      },
      workspace_id: "workspace-1",
      run_id: "run-1",
      surface_id: null,
      source_assertion: sourceAssertion,
      source_corpus: sourceCorpus
    }), "utf8")
    .digest("hex");
  return formatVerifiedUserAssertionV2SourceHash(digest);
}
