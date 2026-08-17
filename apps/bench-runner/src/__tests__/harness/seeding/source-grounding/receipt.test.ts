import { createHash } from "node:crypto";
import {
  buildVerifiedUserAssertionReceiptPreimage,
  buildVerifiedUserAssertionReceiptV2Preimage,
  formatVerifiedUserAssertionSourceHash,
  formatVerifiedUserAssertionV2SourceHash
} from "@do-soul/alaya-protocol";
import { describe, expect, it } from "vitest";
import {
  buildOfficialApiSourceAssertions,
  buildOfficialApiSourceCorpus,
  OfficialApiGardenProvider,
  parseOfficialApiSourceLocator
} from "@do-soul/alaya-soul";
import { attachCompileSourceGrounding } from
  "../../../../harness/seeding/source-grounding.js";
import { extractSeedInputs } from
  "../../../../bench/compile-seed/compile-seed-extract.js";
import type { CompileSeedExtractionStats } from
  "../../../../bench/compile-seed.js";
import { withOpenSemanticFactorGraph } from
  "../../../longmemeval/compile-seed/compile-seed-fixture.js";

describe("compile source grounding receipts", () => {
  it("migrates a digest-valid multiline v1 receipt into a canonical v2 receipt", async () => {
    const assertion = "I prefer tea.";
    const turnMessages = [
      { message_id: "u-prior", role: "user" as const, content: "I live in Berlin." },
      { message_id: "a-prior", role: "assistant" as const, content: "Noted." },
      { message_id: "u-target", role: "user" as const, content: assertion }
    ];
    const legacyCorpus = buildOfficialApiSourceCorpus(assertion, turnMessages);
    const target = buildOfficialApiSourceAssertions(legacyCorpus)
      .find(({ text }) => text.includes(assertion));
    expect(target).toBeDefined();
    const draft = await extractDraft({
      source: assertion,
      matchedText: assertion,
      sourceLocator: assertionLocator(target!.assertion_id),
      surfaceId: "surface-v1-migration",
      turnMessages
    });
    const legacyRaw = {
      ...draft.productionRawPayload,
      full_turn_content: legacyCorpus,
      source_locator: assertionLocator(target!.assertion_id),
      verified_user_assertion_source_hash: receiptDigest({
        assertion,
        corpus: legacyCorpus,
        surfaceId: "surface-v1-migration"
      })
    };

    const payload = attachCompileSourceGrounding(
      legacyRaw,
      {
        ...draft,
        productionSignalId: "legacy-signal-id",
        evidenceRef: "message-v1-migration",
        surfaceId: "surface-v1-migration"
      },
      {
        workspaceId: "workspace-receipt",
        runId: "run-receipt",
        signalId: "current-signal-id"
      }
    );

    const locator = parseOfficialApiSourceLocator(payload.source_locator);
    expect(locator).not.toBeNull();
    expect(legacyRaw.verified_user_assertion_source_hash)
      .toMatch(/^sha256:garden-verified-user-assertion-v1:/u);
    expect(payload.full_turn_content).toBe(`User: ${assertion}`);
    expect(payload.verified_user_assertion_source_hash).toBe(
      receiptV2Digest(assertion, `User: ${assertion}`, locator!)
    );
    expect(payload.source_grounding).toMatchObject({
      status: "grounded",
      source_assertion: assertion
    });
  });

  it("replays a contextual verbatim user assertion through its full-corpus receipt", async () => {
    const assertion =
      "I actually went there with some friends during my study abroad program at the University of Melbourne.";
    const userContent = [
      assertion,
      "I've been to the Great Ocean Road, and it was beautiful.",
      "We had a blast exploring the coast."
    ].join(" ");
    const turnMessages = [{
      message_id: "u-earlier-context",
      role: "user" as const,
      content: "I studied in Sydney before moving south."
    }, {
      message_id: "a-long-context",
      role: "assistant" as const,
      content: "Background context without a user claim. ".repeat(80)
    }, {
      message_id: "u-long-context",
      role: "user" as const,
      content: userContent
    }];
    const canonicalCorpus = buildOfficialApiSourceCorpus(userContent, turnMessages);
    const persistedCorpus = `User: ${userContent}`;
    const targetAnchor = buildOfficialApiSourceAssertions(canonicalCorpus)
      .find(({ text }) => text.includes("Great Ocean Road"));
    expect(targetAnchor).toBeDefined();
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor: {
        extract: async () => ({
          rawJson: JSON.stringify({
            signals: [withOpenSemanticFactorGraph({
              signal_kind: "potential_claim",
              object_kind: "fact",
              confidence: 0.9,
              matched_text: assertion,
              source_locator: assertionLocator(targetAnchor!.assertion_id)
            })]
          })
        })
      },
      generateSignalId: () => "signal-long-context"
    });
    const [draft] = await extractSeedInputs({
      provider,
      stats: extractionStats(),
      turnContent: userContent,
      seedIndex: 0,
      context: {
        workspace_id: "workspace-long-context",
        run_id: "run-long-context",
        surface_id: "surface-long-context",
        turn_messages: turnMessages
      }
    });
    const cachedCorpus = draft?.productionRawPayload?.full_turn_content;

    expect(typeof cachedCorpus).toBe("string");
    expect((cachedCorpus as string).length).toBeLessThanOrEqual(2_048);
    expect(cachedCorpus).not.toBe(canonicalCorpus);
    expect(draft?.productionRawPayload).toMatchObject({
      source_assertion: assertion,
      verified_user_assertion_source_hash: expect.any(String),
      source_grounding: { status: "grounded", source_assertion: assertion }
    });

    const payload = attachCompileSourceGrounding(
      draft!.productionRawPayload!,
      {
        ...draft!,
        evidenceRef: "message-long-context",
        surfaceId: "surface-long-context"
      },
      { workspaceId: "workspace-long-context", runId: "run-long-context" }
    );

    for (const identity of [
      { workspaceId: "wrong-workspace", runId: "run-long-context" },
      { workspaceId: "workspace-long-context", runId: "wrong-run" }
    ]) {
      const tamperedReplay = attachCompileSourceGrounding(
        draft!.productionRawPayload!,
        {
          ...draft!,
          evidenceRef: "message-long-context",
          surfaceId: "surface-long-context"
        },
        identity
      );
      expect(tamperedReplay.source_grounding).toMatchObject({
        status: "rejected",
        reasons: ["cached_source_corpus_mismatch"]
      });
    }

    expect(payload.full_turn_content).toBe(persistedCorpus);
    expect(payload.verified_user_assertion_source_hash).toBe(receiptDigest({
      assertion,
      corpus: persistedCorpus,
      surfaceId: "surface-long-context",
      workspaceId: "workspace-long-context",
      runId: "run-long-context"
    }));
    expect(payload.verified_user_assertion_source_hash)
      .not.toBe(draft?.productionRawPayload?.verified_user_assertion_source_hash);
    expect(payload.source_grounding).toMatchObject({
      status: "grounded",
      content_basis: "source_assertion",
      source_assertion: assertion,
      reasons: []
    });
  });

  it("rejects a locator that widens the signed assertion", async () => {
    const source = "I use TypeScript, but I avoid any.";
    const draft = await extractDraft({
      source,
      matchedText: "I use TypeScript",
      sourceLocator: assertionLocator(2),
      surfaceId: "surface-locator"
    });

    const payload = attachCompileSourceGrounding(
      { ...draft.productionRawPayload, source_locator: assertionLocator(1) },
      { ...draft, evidenceRef: "message-locator", surfaceId: "surface-locator" },
      { workspaceId: "workspace-receipt", runId: "run-receipt" }
    );

    expect(payload.source_grounding).toMatchObject({
      status: "rejected",
      reasons: ["verified_source_assertion_mismatch"]
    });
  });

  it("rejects a receipt-shaped assertion owned by Assistant context", async () => {
    const userSource = "I moved to Berlin last year.";
    const assistantAssertion = "I work remotely.";
    const turnMessages = [
      { message_id: "u-receipt", role: "user" as const, content: userSource },
      { message_id: "a-receipt", role: "assistant" as const, content: assistantAssertion }
    ];
    const draft = await extractDraft({
      source: userSource,
      matchedText: userSource,
      sourceLocator: assertionLocator(1),
      surfaceId: "surface-assistant",
      turnMessages
    });
    const corpus = buildOfficialApiSourceCorpus(userSource, turnMessages);
    const forgedRaw = {
      ...draft.productionRawPayload,
      source_assertion: assistantAssertion,
      verified_user_assertion_source_hash: receiptDigest({
        assertion: assistantAssertion,
        corpus,
        surfaceId: "surface-assistant"
      })
    };

    const payload = attachCompileSourceGrounding(
      forgedRaw,
      { ...draft, evidenceRef: "message-assistant", surfaceId: "surface-assistant" },
      { workspaceId: "workspace-receipt", runId: "run-receipt" }
    );

    expect(payload.source_grounding).toMatchObject({ status: "rejected" });
  });
});

async function extractDraft(input: {
  readonly source: string;
  readonly matchedText: string;
  readonly sourceLocator: ReturnType<typeof assertionLocator>;
  readonly surfaceId: string;
  readonly turnMessages?: readonly {
    readonly message_id: string;
    readonly role: "user" | "assistant";
    readonly content: string;
  }[];
}) {
  const turnMessages = input.turnMessages ?? [{
    message_id: "u-receipt",
    role: "user" as const,
    content: input.source
  }];
  const provider = new OfficialApiGardenProvider({
    apiKey: "sk-test",
    extractor: { extract: async () => ({ rawJson: JSON.stringify({
      signals: [withOpenSemanticFactorGraph({
        signal_kind: "potential_claim",
        object_kind: "fact",
        confidence: 0.9,
        matched_text: input.matchedText,
        source_locator: input.sourceLocator
      })]
    }) }) },
    generateSignalId: () => "signal-receipt"
  });
  const [draft] = await extractSeedInputs({
    provider,
    stats: extractionStats(),
    turnContent: input.source,
    seedIndex: 0,
    context: {
      workspace_id: "workspace-receipt",
      run_id: "run-receipt",
      surface_id: input.surfaceId,
      turn_messages: turnMessages
    }
  });
  return draft!;
}

function receiptDigest(input: {
  readonly assertion: string;
  readonly corpus: string;
  readonly surfaceId: string;
  readonly workspaceId?: string;
  readonly runId?: string;
}): string {
  return formatVerifiedUserAssertionSourceHash(createHash("sha256").update(
    buildVerifiedUserAssertionReceiptPreimage({
    workspace_id: input.workspaceId ?? "workspace-receipt",
    run_id: input.runId ?? "run-receipt",
    surface_id: input.surfaceId,
    source_assertion: input.assertion,
    source_corpus: input.corpus
    }),
    "utf8"
  ).digest("hex"));
}

function receiptV2Digest(
  assertion: string,
  corpus: string,
  sourceLocator: NonNullable<ReturnType<typeof parseOfficialApiSourceLocator>>
): string {
  return formatVerifiedUserAssertionV2SourceHash(createHash("sha256").update(
    buildVerifiedUserAssertionReceiptV2Preimage({
      signal_id: "current-signal-id",
      source_locator: sourceLocator,
      workspace_id: "workspace-receipt",
      run_id: "run-receipt",
      surface_id: "surface-v1-migration",
      source_assertion: assertion,
      source_corpus: corpus
    }),
    "utf8"
  ).digest("hex"));
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
