import { createHash } from "node:crypto";
import {
  BoundedJsonObjectSchema,
  buildVerifiedUserAssertionReceiptV2Preimage,
  formatVerifiedUserAssertionV2SourceHash
} from "@do-soul/alaya-protocol";
import { describe, expect, it } from "vitest";
import { OfficialApiGardenProvider } from "../../../garden/ingestion/compute-provider.js";
import { buildOfficialApiSourceCorpus, parseOfficialApiSourceLocator } from
  "../../../garden/triage/grounding/source-locator.js";
import { resolveGardenSignalGrounding } from
  "../../../garden/triage/grounding/signal-source-grounding.js";
import { buildEvidenceInput } from "../../../garden/materialization/materialization-router.js";
import {
  createContext,
  createExtractor,
  openSignal
} from "./compute-provider-fixtures.js";

describe("OfficialApiGardenProvider verified assertion receipt", () => {
  it("preserves a long source through a bounded verified assertion receipt", async () => {
    const assertion = "I use the cobalt release channel for production deployments.";
    const messages = [
      {
        message_id: "user-long-source",
        role: "user" as const,
        content: assertion,
        created_at: "2026-08-09T00:00:00.000Z"
      },
      {
        message_id: "assistant-long-source",
        role: "assistant" as const,
        content: "Background diagnostics. ".repeat(900),
        created_at: "2026-08-09T00:00:01.000Z"
      }
    ];
    expect(buildOfficialApiSourceCorpus(assertion, messages).length).toBeGreaterThan(16_384);
    const provider = new OfficialApiGardenProvider({
      apiKey: "sk-test",
      extractor: createExtractor(JSON.stringify({ signals: [openSignal({
        signal_kind: "potential_claim",
        object_kind: "deployment_preference",
        confidence: 0.9,
        matched_text: assertion
      })] })),
      generateSignalId: () => "signal-long-source"
    });

    const [signal] = await provider.compile(assertion, {
      ...createContext(),
      turn_messages: messages
    });

    expect(signal).toBeDefined();
    expect(BoundedJsonObjectSchema.safeParse(signal?.raw_payload).success).toBe(true);
    expect(signal?.raw_payload.semantic_factor_graph).toBeDefined();
    const persistedCorpus = String(signal?.raw_payload.full_turn_content);
    expect(persistedCorpus).toBe(`User: ${assertion}`);
    expect(persistedCorpus).not.toContain("Background diagnostics.");
    const sourceLocator = parseOfficialApiSourceLocator(signal?.raw_payload.source_locator);
    expect(sourceLocator).not.toBeNull();
    const sourceHash = expectedVerifiedAssertionHash(
      assertion,
      persistedCorpus,
      signal!.signal_id,
      sourceLocator!
    );
    expect(signal?.raw_payload.verified_user_assertion_source_hash).toBe(sourceHash);
    expect(buildEvidenceInput(signal!, undefined, { fullTurnExcerpt: true })).toMatchObject({
      excerpt: assertion,
      source_hash: sourceHash
    });
    const tampered = {
      ...signal!,
      raw_payload: {
        ...signal!.raw_payload,
        verified_user_assertion_source_hash:
          "sha256:garden-verified-user-assertion-v1:not-a-digest"
      }
    };
    expect(resolveGardenSignalGrounding(tampered)).toEqual({
      status: "rejected",
      reason: "source_grounding_rejected"
    });
    expect(buildEvidenceInput(tampered, undefined, { fullTurnExcerpt: true }).source_hash)
      .toBeNull();
  });
});

function expectedVerifiedAssertionHash(
  assertion: string,
  sourceCorpus: string,
  signalId: string,
  sourceLocator: NonNullable<ReturnType<typeof parseOfficialApiSourceLocator>>
): string {
  const digest = createHash("sha256")
    .update(buildVerifiedUserAssertionReceiptV2Preimage({
      signal_id: signalId,
      source_locator: sourceLocator,
      workspace_id: "workspace-1",
      run_id: "run-1",
      surface_id: "surface-1",
      source_assertion: assertion,
      source_corpus: sourceCorpus
    }), "utf8")
    .digest("hex");
  return formatVerifiedUserAssertionV2SourceHash(digest);
}
