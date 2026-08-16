import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildVerifiedUserAssertionReceiptV2Preimage,
  formatVerifiedUserAssertionV2SourceHash,
  type CandidateMemorySignal
} from "@do-soul/alaya-protocol";
import { RULE_BASED_EVIDENCE_FACT_FRAME_NORMALIZER_OPERATOR_ID } from
  "@do-soul/alaya-core";
import {
  GARDEN_FACT_FRAME_PRODUCER_OPERATOR_ID,
  parseOfficialApiSemanticFactorGraphProjectionAudit
} from "@do-soul/alaya-soul";
import { cacheFilePath } from "../../../longmemeval/compile-seed/compile-seed-cache.js";
import {
  EXTRACTION_REPLAY_FORMATION_POLICY,
  hashExtractionReplay,
  replayExtractionOccurrences,
  type ExtractionReplayAuditor
} from "../../../longmemeval/extraction/cache-audit/replay.js";
import { withOpenSemanticFactorGraph } from
  "../compile-seed/compile-seed-fixture.js";

const roots: string[] = [];
const model = "gpt-5.4-mini";
const requestProfile = "provider-default-v1" as const;

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("extraction cache replay occurrence accounting", () => {
  it("replays each occurrence with its explicit source time even when the raw key repeats", () => {
    const root = cacheRoot();
    const key = "a".repeat(64);
    writeShard(root, key, validRaw());
    const seen: { source: string; created: string; signalId: string }[] = [];
    const result = replayExtractionOccurrences({
      cacheRoot: root,
      model,
      requestProfile,
      occurrences: [occurrence("q-s0-r0", key, "2025-01-01T00:00:00.000Z"), occurrence("q-s1-r0", key, "2025-02-01T00:00:00.000Z")],
      audit: auditor((input) => {
        seen.push({ source: input.source_observed_at!, created: input.created_at, signalId: input.signal_id_for(0) });
        return resultFor([admitted(0, formedSignal("source fact", "User: source fact"))]);
      })
    });

    expect(seen.map((entry) => [entry.source, entry.created])).toEqual([
      ["2025-01-01T00:00:00.000Z", "2025-01-01T00:00:00.000Z"],
      ["2025-02-01T00:00:00.000Z", "2025-02-01T00:00:00.000Z"]
    ]);
    expect(seen[0]?.signalId).not.toBe(seen[1]?.signalId);
    expect(result.closure).toMatchObject({ occurrenceCount: 2, accountedOccurrences: 2, elementCount: 2, admitted: 2, invalid: 0 });
  });

  it("makes a missing cache shard an explicit invalid occurrence and never invokes formation", () => {
    const calls: unknown[] = [];
    const result = replayExtractionOccurrences({
      cacheRoot: cacheRoot(), model, requestProfile,
      occurrences: [occurrence("q-s0-r0", "b".repeat(64), "2025-01-01T00:00:00.000Z")],
      audit: auditor((input) => {
        calls.push(input);
        return resultFor([]);
      })
    });

    expect(calls).toEqual([]);
    expect(result.occurrences[0]?.entries).toEqual([{
      index: -1,
      sourceCacheKey: "b".repeat(64),
      disposition: "invalid",
      stage: "cache",
      reason: `shard_missing:${"b".repeat(12)}`
    }]);
    expect(result.closure.invalid).toBe(1);
  });

  it("defers a missing shard only when the refill audit explicitly allows it", () => {
    const calls: unknown[] = [];
    const result = replayExtractionOccurrences({
      cacheRoot: cacheRoot(), model, requestProfile,
      occurrences: [occurrence("q-s0-r0", "b".repeat(64), "2025-01-01T00:00:00.000Z")],
      allowMissingShards: true,
      audit: auditor((input) => {
        calls.push(input);
        return resultFor([]);
      })
    });

    expect(calls).toEqual([]);
    expect(result.occurrences[0]?.entries).toEqual([{
      index: -1,
      sourceCacheKey: "b".repeat(64),
      disposition: "deferred",
      stage: "cache",
      reason: `shard_missing:${"b".repeat(12)}`
    }]);
    expect(result.closure).toMatchObject({ deferred: 1, invalid: 0 });
  });

  it("accounts for a valid empty extractor result without inventing a signal", () => {
    const root = cacheRoot();
    const key = "c".repeat(64);
    writeShard(root, key, JSON.stringify({ signals: [] }));
    const result = replayExtractionOccurrences({
      cacheRoot: root, model, requestProfile,
      occurrences: [occurrence("q-s0-r0", key, "2025-01-01T00:00:00.000Z")],
      audit: auditor(() => resultFor([]))
    });

    expect(result.occurrences[0]?.entries).toEqual([]);
    expect(result.closure).toMatchObject({ occurrenceCount: 1, accountedOccurrences: 1, elementCount: 0, invalid: 0 });
  });

  it("binds each audited entry to its source shard and defers quarantined shards", () => {
    const root = cacheRoot();
    const first = "1".repeat(64);
    const second = "2".repeat(64);
    writeShard(root, first, validRaw());
    writeShard(root, second, validRaw());
    const audited = replayExtractionOccurrences({
      cacheRoot: root, model, requestProfile,
      occurrences: [multiShardOccurrence("q-s0-r0", [first, second])],
      audit: auditor(() => resultFor([{
        index: 0, disposition: "invalid", stage: "parse", reason: "entry_schema_invalid"
      }]))
    });

    expect(audited.occurrences[0]?.entries.map((entry) => entry.sourceCacheKey))
      .toEqual([first, second]);

    const replayed = replayExtractionOccurrences({
      cacheRoot: root, model, requestProfile,
      occurrences: [multiShardOccurrence("q-s0-r0", [first, second])],
      semanticQuarantinedCacheKeys: new Set([second]),
      allowMissingShards: true,
      audit: auditor(() => {
        throw new Error("quarantined occurrence must not be audited");
      })
    });
    expect(replayed.occurrences[0]?.entries).toEqual([{
      index: -1,
      sourceCacheKey: second,
      disposition: "deferred",
      stage: "cache",
      reason: `shard_missing:${second.slice(0, 12)}`
    }]);
    expect(replayed.closure).toMatchObject({ deferred: 1, invalid: 0 });
  });
});

describe("extraction cache replay rejection", () => {
  it("rejects graphless raw entries under the current signal contract", () => {
    const root = cacheRoot();
    const key = "d".repeat(64);
    writeShard(root, key, JSON.stringify({ signals: [{
      object_kind: "fact",
      confidence: 0.8,
      matched_text: "source fact"
    }] }));

    const result = replayExtractionOccurrences({
      cacheRoot: root,
      model,
      requestProfile,
      occurrences: [occurrence("q-s0-r0", key, "2025-01-01T00:00:00.000Z")],
      requireSemanticFactorGraph: true
    });

    expect(result.occurrences[0]?.entries[0]).toMatchObject({
      disposition: "invalid",
      stage: "parse",
      reason: "semantic_factor_graph_required",
      semanticFactorGraphProjection: {
        status: "unavailable",
        reason: "semantic_factor_graph_missing"
      }
    });
  });

  it("commits graph projection failure for a later rejected candidate", () => {
    const root = cacheRoot();
    const key = "e".repeat(64);
    writeShard(root, key, validRaw());
    const result = replayExtractionOccurrences({
      cacheRoot: root,
      model,
      requestProfile,
      occurrences: [occurrence("q-s0-r0", key, "2025-01-01T00:00:00.000Z")],
      audit: auditor(() => resultFor([{
        index: 0,
        disposition: "rejected",
        stage: "grounding",
        reason: "matched_text_absent",
        semantic_factor_graph_projection: {
          status: "rejected",
          reason: "semantic_factor_graph_invalid_shape"
        }
      }]))
    });

    expect(result.occurrences[0]?.entries[0]).toMatchObject({
      disposition: "rejected",
      semanticFactorGraphProjection: {
        status: "rejected",
        reason: "semantic_factor_graph_invalid_shape"
      }
    });
  });

  it("fails closed when an admitted entry omits its formed signal", () => {
    const root = cacheRoot();
    const key = "f".repeat(64);
    writeShard(root, key, validRaw());

    expect(() => replayExtractionOccurrences({
      cacheRoot: root,
      model,
      requestProfile,
      occurrences: [occurrence("q-s0-r0", key, "2025-01-01T00:00:00.000Z")],
      audit: auditor(() => resultFor([{
        index: 0,
        disposition: "admitted",
        stage: "formation",
        reason: "formed"
      }]))
    })).toThrow("admitted extraction signal missing fact-frame formation commitment");
  });

  it("has a stable replay digest independent of occurrence input order", () => {
    const root = cacheRoot();
    const first = "a".repeat(64);
    const second = "b".repeat(64);
    writeShard(root, first, JSON.stringify({ signals: [] }));
    writeShard(root, second, JSON.stringify({ signals: [] }));
    const input = {
      cacheRoot: root, model, requestProfile, audit: auditor(() => resultFor([]))
    };
    const forward = replayExtractionOccurrences({
      ...input, occurrences: [occurrence("q-2-s0-r0", second, "2025-02-01T00:00:00.000Z"), occurrence("q-1-s0-r0", first, "2025-01-01T00:00:00.000Z")]
    });
    const reversed = replayExtractionOccurrences({
      ...input, occurrences: [occurrence("q-1-s0-r0", first, "2025-01-01T00:00:00.000Z"), occurrence("q-2-s0-r0", second, "2025-02-01T00:00:00.000Z")]
    });

    expect(hashExtractionReplay(forward)).toBe(hashExtractionReplay(reversed));
    expect(hashExtractionReplay(forward)).not.toBe(hashExtractionReplay({
      ...forward,
      factFramePolicy: {
        ...forward.factFramePolicy,
        fullTurnEvidence: !forward.factFramePolicy.fullTurnEvidence
      }
    }));
  });
});

describe("extraction cache replay content binding", () => {
  it("commits the final grounded assertion and formed content", () => {
    const root = cacheRoot();
    const key = "d".repeat(64);
    writeShard(root, key, validRaw());
    const replay = (
      assertion: string,
      fullTurnContent: string,
      rawPayload: Readonly<Record<string, unknown>> = {}
    ) => {
      const projection = parseOfficialApiSemanticFactorGraphProjectionAudit(
        rawPayload.semantic_factor_graph_projection
      );
      return replayExtractionOccurrences({
        cacheRoot: root,
        model,
        requestProfile,
        occurrences: [occurrence("q-s0-r0", key, "2025-01-01T00:00:00.000Z")],
        audit: auditor(() => resultFor([{
          index: 0,
          disposition: "admitted",
          stage: "formation",
          reason: "formed",
          ...(projection === null ? {} : { semantic_factor_graph_projection: projection }),
          signal: {
            ...formedSignal(assertion, fullTurnContent),
            raw_payload: {
              ...formedSignal(assertion, fullTurnContent).raw_payload,
              ...rawPayload
            }
          }
        }]))
      });
    };
    const first = replay("I live in Berlin.", "User: I live in Berlin.");
    const changedAssertion = replay("I live in Paris.", "User: I live in Berlin.");
    const changedContent = replay("I live in Berlin.", "User: I live in Berlin.\nAssistant: noted");
    const rejectedProjection = replay(
      "I live in Berlin.",
      "User: I live in Berlin.",
      {
        semantic_factor_graph_projection: {
          status: "rejected",
          reason: "semantic_factor_graph_invalid_shape"
        }
      }
    );

    expect(first.occurrences[0]?.entries[0]).toMatchObject({
      sourceAssertion: "I live in Berlin.",
      formedContentSha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
    });
    expect(rejectedProjection.occurrences[0]?.entries[0]).toMatchObject({
      semanticFactorGraphProjection: {
        status: "rejected",
        reason: "semantic_factor_graph_invalid_shape"
      }
    });
    expect(hashExtractionReplay(first)).not.toBe(hashExtractionReplay(changedAssertion));
    expect(hashExtractionReplay(first)).not.toBe(hashExtractionReplay(changedContent));
    expect(hashExtractionReplay(first)).not.toBe(hashExtractionReplay(rejectedProjection));
  });
});

describe("extraction cache replay formation closure", () => {
  it("closes every admitted signal through the production fact-frame formation states", () => {
    const root = cacheRoot();
    const key = "e".repeat(64);
    writeShard(root, key, validRaw());
    const result = replayExtractionOccurrences({
      cacheRoot: root,
      model,
      requestProfile,
      occurrences: [occurrence("q-s0-r0", key, "2025-01-01T00:00:00.000Z")],
      audit: auditor(() => resultFor([
        admitted(0, factFrameSignal("formed")),
        admitted(1, factFrameSignal("rejected")),
        admitted(2, factFrameSignal("unavailable")),
        admitted(3, factFrameSignal("ineligible"))
      ]))
    });

    expect(result.factFrameClosure).toEqual({
      admittedSignalCount: 4,
      accountedSignalCount: 4,
      formed: 1,
      ineligible: 1,
      unavailable: 1,
      rejected: 1,
      factKeyProjectionCount: 4
    });
    expect(result.factFramePolicy).toEqual(EXTRACTION_REPLAY_FORMATION_POLICY);
    expect(result.occurrences[0]?.entries.map(({ factFrameFormation }) =>
      factFrameFormation)).toEqual([
      {
        status: "formed",
        producerOperatorId: GARDEN_FACT_FRAME_PRODUCER_OPERATOR_ID,
        factKeyProjectionCount: 4,
        factKeyProjectionSha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
      },
      {
        status: "rejected",
        producerOperatorId: GARDEN_FACT_FRAME_PRODUCER_OPERATOR_ID,
        factKeyProjectionCount: 0,
        factKeyProjectionSha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
      },
      {
        status: "unavailable",
        producerOperatorId:
          RULE_BASED_EVIDENCE_FACT_FRAME_NORMALIZER_OPERATOR_ID,
        factKeyProjectionCount: 0,
        factKeyProjectionSha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
      },
      {
        status: "ineligible",
        producerOperatorId: null,
        factKeyProjectionCount: 0,
        factKeyProjectionSha256: expect.stringMatching(/^[a-f0-9]{64}$/u)
      }
    ]);
  });
});

function cacheRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "alaya-extraction-replay-"));
  roots.push(root);
  return root;
}

function writeShard(root: string, cacheKey: string, rawJson: string): void {
  const path = cacheFilePath(root, cacheKey);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({ cache_key: cacheKey, model, request_profile: requestProfile, raw_json: rawJson }), "utf8");
}

function validRaw(): string {
  return JSON.stringify({
    signals: [withOpenSemanticFactorGraph({
      signal_kind: "potential_claim",
      object_kind: "fact",
      confidence: 0.8,
      matched_text: "source fact",
      evidence_refs: [],
      source_memory_refs: [],
      canonical_entities: [],
      temporal_projection: null,
      preference_profile: null
    })]
  });
}

function occurrence(id: string, cacheKey: string, sourceObservedAt: string) {
  return {
    id, evidenceRef: id, questionId: id.split("-")[0]!, sessionIndex: 0, roundIndex: 0,
    sourceObservedAt,
    turnContent: "User: source fact",
    turnMessages: [{ message_id: `${id}-m0`, role: "user" as const, content: "source fact" }],
    cacheKeys: [cacheKey]
  };
}

function multiShardOccurrence(id: string, cacheKeys: readonly string[]) {
  return {
    ...occurrence(id, cacheKeys[0]!, "2025-01-01T00:00:00.000Z"),
    cacheKeys
  };
}

function auditor(implementation: ExtractionReplayAuditor): ExtractionReplayAuditor {
  return implementation;
}

function resultFor(entries: readonly { index: number; disposition: "admitted" | "deferred" | "rejected" | "invalid"; stage: string; reason: string; signal?: CandidateMemorySignal }[]) {
  return {
    mode: "strict" as const,
    envelope: { disposition: "admitted" as const, reason: "strict_envelope_parsed" as const },
    entries
  };
}

function admitted(index: number, signal: CandidateMemorySignal) {
  return { index, disposition: "admitted" as const, stage: "formation", reason: "formed", signal };
}

function formedSignal(assertion: string, fullTurnContent: string): CandidateMemorySignal {
  return {
    signal_id: "signal-formed",
    workspace_id: "workspace-replay",
    run_id: "run-replay",
    surface_id: null,
    source: "garden_compile",
    signal_kind: "potential_claim",
    signal_state: "emitted",
    object_kind: "fact",
    scope_hint: null,
    domain_tags: [],
    confidence: 0.8,
    evidence_refs: [],
    canonical_entities: [],
    source_memory_refs: [],
    supersedes_refs: [],
    exception_to_refs: [],
    contradicts_refs: [],
    incompatible_with_refs: [],
    source_observation: null,
    raw_payload: {
      source_assertion: assertion,
      matched_text: assertion,
      distilled_fact: assertion,
      full_turn_content: fullTurnContent
    },
    created_at: "2025-01-01T00:00:00.000Z"
  };
}

function factFrameSignal(
  mode: "formed" | "ineligible" | "rejected" | "unavailable"
): CandidateMemorySignal {
  const assertion = mode === "unavailable" ? "I am the sole member." : "I use Atlas.";
  const signal = formedSignal(assertion, `User: ${assertion}`);
  if (mode === "ineligible") {
    return { ...signal, signal_id: `signal-${mode}` };
  }
  const frame = {
    schema_version: 1 as const,
    slots: [
      { role: "subject" as const, text: "I" },
      { role: "relation" as const, text: "use" },
      { role: "value" as const, text: mode === "rejected" ? "Nova" : "Atlas" }
    ]
  };
  const signalId = `signal-${mode}`;
  const sourceLocator = {
    contract_version: 2 as const,
    kind: "assertion_catalog" as const,
    assertion_id: 1
  };
  return {
    ...signal,
    signal_id: signalId,
    raw_payload: {
      ...signal.raw_payload,
      source_locator: sourceLocator,
      verified_user_assertion_source_hash: verifiedAssertionReceipt({
        signalId,
        sourceLocator,
        assertion,
        sourceCorpus: `User: ${assertion}`
      }),
      source_grounding: {
        version: 1,
        status: "grounded",
        content_basis: "source_assertion",
        source_assertion: assertion,
        proposed_matched_text: assertion,
        reasons: [],
        ...(mode === "rejected" ? {
          proposed_fact_frame: frame,
          reasons: ["proposed_fact_frame_not_source_grounded"]
        } : {})
      },
      ...(mode === "formed" ? { fact_frame: frame } : {})
    }
  };
}

function verifiedAssertionReceipt(input: Readonly<{
  readonly signalId: string;
  readonly sourceLocator: {
    readonly contract_version: 2;
    readonly kind: "assertion_catalog";
    readonly assertion_id: number;
  };
  readonly assertion: string;
  readonly sourceCorpus: string;
}>): string {
  const digest = createHash("sha256").update(
    buildVerifiedUserAssertionReceiptV2Preimage({
      signal_id: input.signalId,
      source_locator: input.sourceLocator,
      workspace_id: "workspace-replay",
      run_id: "run-replay",
      surface_id: null,
      source_assertion: input.assertion,
      source_corpus: input.sourceCorpus
    }),
    "utf8"
  ).digest("hex");
  return formatVerifiedUserAssertionV2SourceHash(digest);
}
