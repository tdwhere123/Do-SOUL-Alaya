import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cacheFilePath } from "../../longmemeval/compile-seed-cache.js";
import {
  hashExtractionReplay,
  replayExtractionOccurrences,
  type ExtractionReplayAuditor
} from "../../longmemeval/extraction/cache-audit/replay.js";

const roots: string[] = [];
const model = "gpt-5.4-mini";
const requestProfile = "provider-default-v1" as const;

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("extraction cache replay", () => {
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
        return resultFor([{ index: 0, disposition: "admitted", stage: "formation", reason: "formed" }]);
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
      index: -1, disposition: "invalid", stage: "cache", reason: "shard_missing"
    }]);
    expect(result.closure.invalid).toBe(1);
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
    signals: [{
      signal_kind: "potential_claim",
      object_kind: "fact",
      confidence: 0.8,
      matched_text: "source fact",
      evidence_refs: [],
      source_memory_refs: [],
      canonical_entities: [],
      temporal_projection: null,
      preference_profile: null
    }]
  });
}

function occurrence(id: string, cacheKey: string, sourceObservedAt: string) {
  return {
    id, evidenceRef: id, questionId: id.split("-")[0]!, sessionIndex: 0, roundIndex: 0,
    sourceObservedAt, turnContent: "User: source fact", cacheKey
  };
}

function auditor(implementation: ExtractionReplayAuditor): ExtractionReplayAuditor {
  return implementation;
}

function resultFor(entries: readonly { index: number; disposition: "admitted" | "deferred" | "rejected" | "invalid"; stage: string; reason: string }[]) {
  return {
    mode: "strict" as const,
    envelope: { disposition: "admitted" as const, reason: "strict_envelope_parsed" as const },
    entries
  };
}
