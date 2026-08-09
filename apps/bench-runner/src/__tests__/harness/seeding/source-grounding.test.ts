import { describe, expect, it } from "vitest";
import type { BenchSignalSeedInput } from "../../../harness/daemon.js";
import {
  buildOfficialApiSourceCorpus,
  OfficialApiGardenProvider
} from "@do-soul/alaya-soul";
import { extractSeedInputs } from "../../../longmemeval/compile-seed/compile-seed-extract.js";
import type {
  CompileSeedExtractionStats
} from "../../../longmemeval/compile-seed.js";
import { attachCompileSourceGrounding } from "../../../harness/seeding/source-grounding.js";
import { withOpenSemanticFactorGraph } from
  "../../longmemeval/compile-seed/compile-seed-fixture.js";

describe("compile source grounding revalidation", () => {
  it("preserves the same unique verbatim assertion accepted by the provider", () => {
    const turnContent =
      "User: I redeemed a coupon last Sunday, which surprised me because I had forgotten it.\n" +
      "Assistant: Nice find.";
    const matchedText = "I redeemed a coupon last Sunday";
    const payload = attachCompileSourceGrounding(
      { matched_text: matchedText, distilled_fact: "User redeemed a coupon." },
      signalInput(turnContent, matchedText)
    );

    expect(payload.source_grounding).toMatchObject({
      status: "grounded",
      content_basis: "source_assertion",
      source_assertion: matchedText
    });
    expect(payload.distilled_fact).toBe(matchedText);
  });

  it("replays the provider locator instead of the model proposal", () => {
    const assertion = "I graduated with a degree in Business Administration.";
    const turnContent = `User: ${assertion}\nAssistant: Congratulations.`;
    const payload = attachCompileSourceGrounding(
      {
        matched_text: assertion,
        source_assertion: assertion,
        proposed_matched_text: assertion,
        full_turn_content: turnContent,
        source_locator: assertionLocator(1),
        source_grounding: {
          version: 1,
          status: "grounded",
          content_basis: "source_assertion",
          source_assertion: assertion,
          proposed_matched_text: assertion,
          reasons: ["matched_text_expanded_to_source_assertion"]
        }
      },
      signalInput(turnContent, assertion)
    );

    expect(payload.source_grounding).toMatchObject({
      status: "grounded",
      source_assertion: assertion,
      proposed_matched_text: assertion
    });
    expect(payload.distilled_fact).toBe(assertion);
  });

  it("replays a previously rejected locator audit from the authoritative corpus", () => {
    const assertion = "I graduated with a degree in Business Administration.";
    const turnContent = `User: ${assertion}\nAssistant: Congratulations.`;
    const payload = attachCompileSourceGrounding(
      {
        proposed_matched_text: assertion,
        full_turn_content: turnContent,
        source_locator: assertionLocator(1),
        source_grounding: {
          version: 1,
          status: "rejected",
          content_basis: "none",
          proposed_matched_text: assertion,
          reasons: ["source_grounding_rejected"]
        }
      },
      signalInput(turnContent, assertion)
    );

    expect(payload.source_grounding).toMatchObject({
      status: "grounded",
      source_assertion: assertion
    });
    expect(payload.full_turn_content).toBe(turnContent);
  });

  it("uses the current seed turn instead of a stale cached grounding corpus", () => {
    const staleAssertion = "I prefer dark mode.";
    const staleTurnContent = `User: ${staleAssertion}\nAssistant: Noted.`;
    const currentAssertion = "I prefer light mode.";
    const currentTurnContent = `User: ${currentAssertion}\nAssistant: Noted.`;
    const payload = attachCompileSourceGrounding(
      {
        full_turn_content: staleTurnContent,
        source_locator: assertionLocator(1),
        source_grounding: {
          version: 1,
          status: "grounded",
          content_basis: "source_assertion",
          source_assertion: staleAssertion,
          proposed_matched_text: staleAssertion,
          proposed_preference_profile: {
            projection_schema_version: 1,
            preference_subject: "I",
            preference_predicate: "prefer",
            preference_object: "dark mode",
            preference_polarity: "positive"
          },
          reasons: []
        }
      },
      signalInput(currentTurnContent, currentAssertion)
    );

    expect(payload.full_turn_content).toBe(currentTurnContent);
    expect(payload.source_grounding).toMatchObject({
      status: "rejected",
      content_basis: "none"
    });
    expect(payload).not.toHaveProperty("preference_profile");
  });

  it("replays an embedded-newline User message with the provider canonical corpus", async () => {
    const turnContent = "I work remotely.\nI prefer dark mode.";
    const turnMessages = [{
      message_id: "u-embedded-newline",
      role: "user" as const,
      content: turnContent
    }];
    const canonicalCorpus = buildOfficialApiSourceCorpus(turnContent, turnMessages);
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor: {
        extract: async () => ({
          rawJson: JSON.stringify({
            signals: [withOpenSemanticFactorGraph({
              signal_kind: "potential_preference",
              object_kind: "preference",
              confidence: 0.9,
              matched_text: "I prefer dark mode.",
              source_locator: assertionLocator(2)
            })]
          })
        })
      },
      generateSignalId: () => "signal-embedded-newline"
    });
    const [draft] = await extractSeedInputs({
      provider,
      stats: extractionStats(),
      turnContent,
      seedIndex: 0,
      context: {
        workspace_id: "workspace-embedded-newline",
        run_id: "run-embedded-newline",
        surface_id: null,
        turn_messages: turnMessages
      }
    });

    expect.soft(draft?.turnMessages).toEqual(turnMessages);
    const payload = attachCompileSourceGrounding(
      draft!.productionRawPayload!,
      { ...draft!, evidenceRef: "message-embedded-newline" }
    );
    expect(payload.full_turn_content).toBe(canonicalCorpus);
    expect(payload.source_grounding).toMatchObject({
      status: "grounded",
      source_assertion: "I prefer dark mode."
    });
  });

  it("replays and re-grounds a prior proposed preference profile", () => {
    const assertion = "I prefer dark mode for the theme.";
    const turnContent = `User: ${assertion}\nAssistant: Noted.`;
    const payload = attachCompileSourceGrounding(
      {
        matched_text: assertion,
        distilled_fact: assertion,
        preference_profile: { preference_object: "stale derived value" },
        full_turn_content: turnContent,
        source_locator: assertionLocator(1),
        source_grounding: {
          version: 1,
          status: "grounded",
          content_basis: "source_assertion",
          source_assertion: assertion,
          proposed_matched_text: assertion,
          proposed_preference_profile: {
            projection_schema_version: 1,
            preference_subject: "I",
            preference_predicate: "enjoy",
            preference_object: "dark mode",
            preference_category: "theme",
            preference_polarity: "positive"
          },
          reasons: ["stale_derived_audit"]
        }
      },
      signalInput(turnContent, assertion)
    );

    expect(payload.preference_profile).toEqual({
      projection_schema_version: 1,
      preference_subject: "operator",
      preference_object: "dark mode",
      preference_category: "theme",
      preference_polarity: "positive"
    });
    expect(payload.source_grounding).toMatchObject({
      status: "grounded",
      proposed_preference_profile: {
        preference_object: "dark mode"
      }
    });
    expect((payload.source_grounding as { reasons: readonly string[] }).reasons)
      .not.toContain("stale_derived_audit");
  });

  it("does not project an oversized preference field from a prior audit", () => {
    const assertion = "I prefer dark mode.";
    const turnContent = `User: ${assertion}\nAssistant: Noted.`;
    const oversizedObject = "x".repeat(1_025);
    const payload = attachCompileSourceGrounding(
      {
        full_turn_content: turnContent,
        source_locator: assertionLocator(1),
        source_grounding: {
          version: 1,
          status: "grounded",
          content_basis: "source_assertion",
          source_assertion: assertion,
          proposed_matched_text: assertion,
          proposed_preference_profile: {
            projection_schema_version: 1,
            preference_subject: "I",
            preference_predicate: "prefer",
            preference_object: oversizedObject,
            preference_polarity: "positive"
          },
          reasons: []
        }
      },
      signalInput(turnContent, assertion)
    );

    expect(payload).not.toHaveProperty("preference_profile");
  });

  it("rejects a locator that selects an Assistant assertion", () => {
    const turnContent = "User: I moved to Paris.\nAssistant: You live in Berlin.";
    const payload = attachCompileSourceGrounding(
      {
        matched_text: "You live in Berlin.",
        source_assertion: "You live in Berlin.",
        proposed_matched_text: "LOCATOR_ONLY",
        full_turn_content: turnContent,
        source_locator: assertionLocator(2),
        source_grounding: {
          version: 1,
          status: "grounded",
          content_basis: "source_assertion",
          source_assertion: "You live in Berlin.",
          proposed_matched_text: "LOCATOR_ONLY",
          reasons: []
        }
      },
      signalInput(turnContent, "You live in Berlin.")
    );

    expect(payload.source_grounding).toMatchObject({
      status: "rejected",
      content_basis: "none",
      proposed_matched_text: "LOCATOR_ONLY"
    });
    expect(payload.full_turn_content).toBe(turnContent);
  });

  it("does not treat a labeled Assistant assertion as unlabeled source", () => {
    const turnContent =
      "User: I prefer light mode.\nAssistant: I prefer dark mode.";
    const assistantAssertion = "I prefer dark mode.";
    const payload = attachCompileSourceGrounding(
      {
        matched_text: assistantAssertion,
        source_grounding: {
          version: 1,
          proposed_matched_text: assistantAssertion,
          proposed_preference_profile: {
            projection_schema_version: 1,
            preference_subject: "I",
            preference_predicate: "prefer",
            preference_object: "dark mode",
            preference_polarity: "positive"
          }
        }
      },
      signalInput(turnContent, assistantAssertion)
    );

    expect(payload.source_grounding).toMatchObject({
      status: "rejected",
      content_basis: "none"
    });
    expect(payload).not.toHaveProperty("preference_profile");
  });

  it.each([
    [
      "Chinese role labels",
      "用户：我偏好浅色模式。\n助手：我偏好深色模式。",
      "我偏好深色模式。",
      "深色模式"
    ],
    [
      "full-width colons",
      "User：I prefer light mode.\nAssistant：I prefer dark mode.",
      "I prefer dark mode.",
      "dark mode"
    ],
    [
      "full-width Latin Assistant label",
      "Ｕｓｅｒ：I prefer light mode.\nＡｓｓｉｓｔａｎｔ：I prefer dark mode.",
      "I prefer dark mode.",
      "dark mode"
    ],
    [
      "zero-width-prefixed Assistant label",
      "User: I prefer light mode.\n\u200BAssistant: I prefer dark mode.",
      "I prefer dark mode.",
      "dark mode"
    ]
  ])("does not treat an Assistant preference as unlabeled with %s", (
    _label,
    turnContent,
    assistantAssertion,
    preferenceObject
  ) => {
    const payload = attachCompileSourceGrounding(
      {
        matched_text: assistantAssertion,
        source_grounding: {
          version: 1,
          proposed_matched_text: assistantAssertion,
          proposed_preference_profile: {
            projection_schema_version: 1,
            preference_subject: "I",
            preference_predicate: "prefer",
            preference_object: preferenceObject,
            preference_polarity: "positive"
          }
        }
      },
      signalInput(turnContent, assistantAssertion)
    );

    expect(payload.source_grounding).toMatchObject({
      status: "rejected",
      content_basis: "none"
    });
    expect(payload).not.toHaveProperty("preference_profile");
  });

  it("continues to ground a genuinely unlabeled single-speaker corpus", () => {
    const assertion = "I prefer dark mode.";
    const payload = attachCompileSourceGrounding(
      {
        matched_text: assertion,
        source_grounding: {
          version: 1,
          proposed_matched_text: assertion,
          proposed_preference_profile: {
            projection_schema_version: 1,
            preference_subject: "I",
            preference_predicate: "prefer",
            preference_object: "dark mode",
            preference_polarity: "positive"
          }
        }
      },
      signalInput(assertion, assertion)
    );

    expect(payload.source_grounding).toMatchObject({
      status: "grounded",
      source_assertion: assertion
    });
    expect(payload.preference_profile).toMatchObject({
      preference_subject: "operator",
      preference_object: "dark mode",
      preference_polarity: "positive"
    });
  });

  it.each([
    ["I moved to Berlin, e.g. for work.", "for work"],
    ["Alice chose Berlin over Paris. The former is cheaper.", "The former is cheaper."]
  ])("rejects a cached proposal that is not a self-contained assertion: %s", (turnContent, matchedText) => {
    const payload = attachCompileSourceGrounding(
      { matched_text: matchedText, distilled_fact: matchedText },
      signalInput(turnContent, matchedText)
    );

    expect(payload.source_grounding).toMatchObject({
      status: "rejected",
      content_basis: "none"
    });
    expect(payload).not.toHaveProperty("distilled_fact");
  });
});

function signalInput(turnContent: string, matchedText: string): BenchSignalSeedInput {
  return {
    signalKind: "potential_claim",
    objectKind: "activity",
    confidence: 0.9,
    distilledFact: matchedText,
    turnContent,
    matchedText,
    evidenceRef: "message-1",
    turnSeedIndex: 0,
    extractionProvider: "official_api_compile"
  };
}

function assertionLocator(assertionId: number) {
  return {
    contract_version: 2,
    kind: "assertion_catalog",
    assertion_id: assertionId
  };
}

function extractionStats(): CompileSeedExtractionStats {
  return {
    path: "official_api_compile",
    cacheHits: 0,
    llmCalls: 0,
    offlineFallbacks: 0,
    liveExtractionFailures: 0,
    cachedExtractionFailures: 0,
    factsProduced: 0,
    signalsDropped: 0,
    signalsDroppedByReason: { candidate_absent: 0, materialization_drop: 0 },
    parseDropped: 0,
    compileOverflowDropped: 0,
    lastTurnRawSignalCount: 1,
    lastTurnDraftCount: 1,
    lastExtractionSource: null,
    lastRawJsonSha256: null
  };
}
