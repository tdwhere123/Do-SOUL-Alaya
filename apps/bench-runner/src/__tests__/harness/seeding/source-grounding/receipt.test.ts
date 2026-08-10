import { describe, expect, it } from "vitest";
import {
  buildOfficialApiSourceCorpus,
  OfficialApiGardenProvider
} from "@do-soul/alaya-soul";
import { attachCompileSourceGrounding } from
  "../../../../harness/seeding/source-grounding.js";
import { extractSeedInputs } from
  "../../../../longmemeval/compile-seed/compile-seed-extract.js";
import type { CompileSeedExtractionStats } from
  "../../../../longmemeval/compile-seed.js";
import { withOpenSemanticFactorGraph } from
  "../../../longmemeval/compile-seed/compile-seed-fixture.js";

describe("compile source grounding receipts", () => {
  it("replays a bounded provider excerpt through its full-corpus receipt", async () => {
    const assertion = "I prefer dark mode.";
    const turnMessages = [{
      message_id: "a-long-context",
      role: "assistant" as const,
      content: "Background context without a user claim. ".repeat(80)
    }, {
      message_id: "u-long-context",
      role: "user" as const,
      content: assertion
    }];
    const canonicalCorpus = buildOfficialApiSourceCorpus(assertion, turnMessages);
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor: {
        extract: async () => ({
          rawJson: JSON.stringify({
            signals: [withOpenSemanticFactorGraph({
              signal_kind: "potential_preference",
              object_kind: "preference",
              confidence: 0.9,
              matched_text: assertion,
              source_locator: assertionLocator(1)
            })]
          })
        })
      },
      generateSignalId: () => "signal-long-context"
    });
    const [draft] = await extractSeedInputs({
      provider,
      stats: extractionStats(),
      turnContent: assertion,
      seedIndex: 0,
      context: {
        workspace_id: "workspace-long-context",
        run_id: "run-long-context",
        surface_id: null,
        turn_messages: turnMessages
      }
    });
    const cachedCorpus = draft?.productionRawPayload?.full_turn_content;

    expect(typeof cachedCorpus).toBe("string");
    expect((cachedCorpus as string).length).toBeLessThanOrEqual(2_048);
    expect(cachedCorpus).not.toBe(canonicalCorpus);

    const payload = attachCompileSourceGrounding(
      draft!.productionRawPayload!,
      { ...draft!, evidenceRef: "message-long-context" },
      { workspaceId: "workspace-long-context", runId: "run-long-context" }
    );
    expect(payload.full_turn_content).toBe(canonicalCorpus);
    expect(payload.source_grounding).toMatchObject({
      status: "grounded",
      content_basis: "source_assertion",
      source_assertion: assertion
    });

    const tamperedReplay = attachCompileSourceGrounding(
      draft!.productionRawPayload!,
      { ...draft!, evidenceRef: "message-long-context" },
      { workspaceId: "workspace-long-context", runId: "wrong-run" }
    );
    expect(tamperedReplay.source_grounding).toMatchObject({
      status: "rejected",
      reasons: ["cached_source_corpus_mismatch"]
    });
  });
});

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
    extractionAttempts: 0,
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
    lastExtractionShards: [],
    lastCacheKey: null,
    lastRawJsonSha256: null
  };
}
