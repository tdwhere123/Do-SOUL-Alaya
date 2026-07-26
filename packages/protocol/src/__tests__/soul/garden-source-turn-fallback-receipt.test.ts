import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildGardenSourceTurnFallbackReceiptPreimage,
  buildGardenSourceTurnFallbackV2ReceiptPreimage,
  formatGardenSourceTurnFallbackArtifactRef,
  formatGardenSourceTurnFallbackSourceHash,
  formatGardenSourceTurnFallbackV2SourceHash,
  hasGardenSourceTurnFallbackAnyReceiptFormat,
  hasGardenSourceTurnFallbackReceiptFormat,
  hasGardenSourceTurnFallbackV2ReceiptFormat,
  isGardenSourceTurnFallbackV2Receipt,
  projectGardenSourceTurnFallbackV2UserContent,
  readGardenSourceTurnFallbackArtifactSignalId,
  readGardenSourceTurnFallbackReceipt,
  readGardenSourceTurnFallbackSourceHashDigest,
  readGardenSourceTurnFallbackV2SourceHashDigest,
  verifyGardenSourceTurnFallbackReceipt
} from "../../index.js";
import { CandidateMemorySignalSchema } from "../../signals/candidate-memory-signal.js";
import type {
  CandidateMemorySignal,
  GardenSourceTurnFallbackRoleSpan
} from "../../index.js";

const DIGEST = "a".repeat(64);

describe("Garden source-turn fallback receipt", () => {
  it("round-trips the shared artifact and source-hash format", () => {
    const artifactRef = formatGardenSourceTurnFallbackArtifactRef("signal-1");
    const sourceHash = formatGardenSourceTurnFallbackSourceHash(DIGEST);

    expect(readGardenSourceTurnFallbackArtifactSignalId(artifactRef)).toBe("signal-1");
    expect(readGardenSourceTurnFallbackSourceHashDigest(sourceHash)).toBe(DIGEST);
    expect(hasGardenSourceTurnFallbackReceiptFormat({
      artifact_ref: artifactRef,
      source_hash: sourceHash
    })).toBe(true);
    expect(hasGardenSourceTurnFallbackReceiptFormat({
      artifact_ref: "alaya:garden-turn-evidence:",
      source_hash: sourceHash
    })).toBe(false);
  });

  it("parses a strict fallback envelope into one canonical preimage", () => {
    const signal = createSignal();
    const receipt = readGardenSourceTurnFallbackReceipt(signal);

    expect(receipt).toMatchObject({
      source_corpus: "Assistant: exact prior answer",
      reason: "empty_extraction",
      truncated: false,
      chars_clipped: 0,
      digest: DIGEST
    });
    expect(receipt?.preimage).toBe(
      buildGardenSourceTurnFallbackReceiptPreimage(receipt!)
    );
    expect(receipt?.preimage).toBe(
      "{\"kind\":\"garden-source-turn-fallback-v1\",\"signal_id\":\"signal-1\"," +
      "\"workspace_id\":\"workspace-1\",\"run_id\":\"run-1\",\"surface_id\":null," +
      "\"created_at\":\"2026-07-25T00:00:00.000Z\",\"source_observation\":null," +
      "\"reason\":\"empty_extraction\",\"truncated\":false,\"chars_clipped\":0," +
      "\"source\":\"Assistant: exact prior answer\"}"
    );
    expect(formatGardenSourceTurnFallbackSourceHash(DIGEST))
      .toBe(`sha256:garden-source-turn-fallback-v1:${DIGEST}`);
    expect(verifyGardenSourceTurnFallbackReceipt(signal, () => DIGEST))
      .toEqual(receipt);
    expect(verifyGardenSourceTurnFallbackReceipt(signal, () => "b".repeat(64)))
      .toBeNull();
  });

  it("rejects an envelope with extra authority or relation fields", () => {
    const signal = createSignal();

    expect(readGardenSourceTurnFallbackReceipt({
      ...signal,
      evidence_refs: ["claim-1"]
    })).toBeNull();
    expect(readGardenSourceTurnFallbackReceipt({
      ...signal,
      raw_payload: {
        ...signal.raw_payload,
        source_assertion: "invented"
      }
    })).toBeNull();
  });

  it("verifies a v2 receipt that binds the corpus and ordered role spans", () => {
    const signal = createV2Signal();
    const receipt = verifyGardenSourceTurnFallbackReceipt(signal, digest);

    expect(isGardenSourceTurnFallbackV2Receipt(receipt)).toBe(true);
    if (!isGardenSourceTurnFallbackV2Receipt(receipt)) {
      throw new Error("expected a verified v2 receipt");
    }
    expect(receipt.preimage).toBe(
      buildGardenSourceTurnFallbackV2ReceiptPreimage(receipt)
    );
    expect(receipt.source_role_spans).toEqual(V2_SPANS);
    expect(projectGardenSourceTurnFallbackV2UserContent(receipt))
      .toBe("first line");
  });

  it("rejects v2 corpus and role-span tampering", () => {
    const signal = createV2Signal();
    const rawPayload = signal.raw_payload;

    expect(verifyGardenSourceTurnFallbackReceipt({
      ...signal,
      raw_payload: {
        ...rawPayload,
        full_turn_content: `${V2_CORPUS}!`
      }
    }, digest)).toBeNull();
    expect(verifyGardenSourceTurnFallbackReceipt({
      ...signal,
      raw_payload: {
        ...rawPayload,
        source_role_spans: [
          { role: "assistant", start: 6, end: 16 },
          V2_SPANS[1]
        ]
      }
    }, digest)).toBeNull();
  });

  it.each([
    {
      name: "empty",
      spans: [{ role: "user", start: 6, end: 6 }]
    },
    {
      name: "out of bounds",
      spans: [{ role: "user", start: 6, end: V2_CORPUS.length + 1 }]
    },
    {
      name: "unsorted",
      spans: [V2_SPANS[1], V2_SPANS[0]]
    },
    {
      name: "overlapping",
      spans: [
        V2_SPANS[0],
        { role: "assistant", start: 15, end: 20 }
      ]
    },
    {
      name: "unexplained corpus gap",
      spans: [
        { role: "user", start: 7, end: 16 },
        V2_SPANS[1]
      ]
    },
    {
      name: "Assistant-only",
      spans: [V2_SPANS[1]]
    }
  ])("rejects $name v2 role spans before digest verification", ({ spans }) => {
    const signal = createV2Signal();

    expect(readGardenSourceTurnFallbackReceipt({
      ...signal,
      raw_payload: {
        ...signal.raw_payload,
        source_role_spans: spans
      }
    })).toBeNull();
  });

  it("rejects a v2 span that splits a Unicode code point", () => {
    const signal = createV2Signal(
      "User: 😀",
      [{ role: "user", start: 6, end: 7 }]
    );

    expect(readGardenSourceTurnFallbackReceipt(signal)).toBeNull();
  });

  it("rejects v2 authority or truncation lookalikes before digest verification", () => {
    const signal = createV2Signal();
    const preservation = signal.raw_payload.evidence_preservation as
      Readonly<Record<string, unknown>>;

    expect(readGardenSourceTurnFallbackReceipt({
      ...signal,
      source_observation: {
        observed_at: "2026-07-25T00:00:00.000Z",
        authority: "verified_delivery_observation",
        source_event_id: "delivery-1"
      }
    })).toBeNull();
    expect(readGardenSourceTurnFallbackReceipt({
      ...signal,
      raw_payload: {
        ...signal.raw_payload,
        evidence_preservation: {
          ...preservation,
          truncated: true,
          chars_clipped: 1
        }
      }
    })).toBeNull();
  });

  it("keeps v1 and v2 source-hash formats disjoint", () => {
    const v1 = formatGardenSourceTurnFallbackSourceHash(DIGEST);
    const v2 = formatGardenSourceTurnFallbackV2SourceHash(DIGEST);

    expect(readGardenSourceTurnFallbackSourceHashDigest(v2)).toBeNull();
    expect(readGardenSourceTurnFallbackV2SourceHashDigest(v1)).toBeNull();
    expect(readGardenSourceTurnFallbackV2SourceHashDigest(v2)).toBe(DIGEST);
    expect(hasGardenSourceTurnFallbackReceiptFormat({
      artifact_ref: formatGardenSourceTurnFallbackArtifactRef("signal-1"),
      source_hash: v2
    })).toBe(false);
    expect(hasGardenSourceTurnFallbackV2ReceiptFormat({
      artifact_ref: formatGardenSourceTurnFallbackArtifactRef("signal-1"),
      source_hash: v2
    })).toBe(true);
    expect([v1, v2].every((source_hash) =>
      hasGardenSourceTurnFallbackAnyReceiptFormat({
        artifact_ref: formatGardenSourceTurnFallbackArtifactRef("signal-1"),
        source_hash
      })
    )).toBe(true);
  });
});

const V2_CORPUS = "User: first line\nAssistant: reply";
const V2_SPANS = Object.freeze([
  Object.freeze({ role: "user" as const, start: 6, end: 16 }),
  Object.freeze({ role: "assistant" as const, start: 28, end: 33 })
]);

function createSignal() {
  return CandidateMemorySignalSchema.parse({
    signal_id: "signal-1",
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    source: "garden_compile",
    signal_kind: "potential_evidence_anchor",
    signal_state: "materialized",
    object_kind: "source_turn",
    scope_hint: null,
    domain_tags: ["source-turn"],
    confidence: 1,
    evidence_refs: [],
    source_memory_refs: [],
    supersedes_refs: [],
    exception_to_refs: [],
    contradicts_refs: [],
    incompatible_with_refs: [],
    raw_payload: {
      full_turn_content: "Assistant: exact prior answer",
      evidence_preservation: {
        version: 1,
        reason: "empty_extraction",
        truncated: false,
        chars_clipped: 0,
        source_receipt_sha256: DIGEST
      }
    },
    source_observation: null,
    created_at: "2026-07-25T00:00:00.000Z"
  });
}

function createV2Signal(
  sourceCorpus = V2_CORPUS,
  sourceRoleSpans: readonly GardenSourceTurnFallbackRoleSpan[] = V2_SPANS
): CandidateMemorySignal {
  const input = {
    signal_id: "signal-v2",
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    created_at: "2026-07-25T00:00:00.000Z",
    source_observation: {
      observed_at: "2026-07-25T00:00:00.000Z",
      authority: "trusted_host_event" as const,
      source_event_id: "event-v2"
    },
    source_corpus: sourceCorpus,
    source_role_spans: sourceRoleSpans,
    reason: "empty_extraction" as const,
    truncated: false as const,
    chars_clipped: 0
  };
  const sourceReceiptSha256 = digest(
    buildGardenSourceTurnFallbackV2ReceiptPreimage(input)
  );
  return CandidateMemorySignalSchema.parse({
    signal_id: input.signal_id,
    workspace_id: input.workspace_id,
    run_id: input.run_id,
    surface_id: input.surface_id,
    source: "garden_compile",
    signal_kind: "potential_evidence_anchor",
    signal_state: "materialized",
    object_kind: "source_turn",
    scope_hint: null,
    domain_tags: ["source-turn"],
    confidence: 1,
    evidence_refs: [],
    source_memory_refs: [],
    supersedes_refs: [],
    exception_to_refs: [],
    contradicts_refs: [],
    incompatible_with_refs: [],
    raw_payload: {
      full_turn_content: input.source_corpus,
      source_role_spans: input.source_role_spans,
      evidence_preservation: {
        version: 2,
        reason: input.reason,
        truncated: input.truncated,
        chars_clipped: input.chars_clipped,
        source_receipt_sha256: sourceReceiptSha256
      }
    },
    source_observation: input.source_observation,
    created_at: input.created_at
  });
}

function digest(preimage: string): string {
  return createHash("sha256").update(preimage, "utf8").digest("hex");
}
