import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertFreshC0RebuildRoot,
  decideC0Reuse,
  hashC0Decision
} from "../../longmemeval/extraction/c0/decision.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("C0 reuse decision", () => {
  it("permits reuse only with complete replay and exact identity", () => {
    const result = decideC0Reuse({
      sourceRoot: "/cache/canonical",
      source: identity(),
      final: identity(),
      replay: completeReplay()
    });

    expect(result.action).toBe("reuse");
    expect(result.reasons).toEqual([]);
    expect(hashC0Decision(result)).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("forces rebuild for semantic drift even when raw identity matches", () => {
    const final = identity();
    const result = decideC0Reuse({
      sourceRoot: "/cache/canonical",
      source: identity(),
      final: { ...final, formationSemanticsSha256: "f".repeat(64) },
      replay: completeReplay()
    });

    expect(result.action).toBe("rebuild");
    expect(result.reasons).toContain("formation_semantics_mismatch");
  });

  it("forces rebuild for any invalid or unaccounted replay outcome", () => {
    const result = decideC0Reuse({
      sourceRoot: "/cache/canonical",
      source: identity(),
      final: identity(),
      replay: { ...completeReplay(), invalid: 1, accountedElements: 3 }
    });

    expect(result.action).toBe("rebuild");
    expect(result.reasons).toContain("replay_not_closed");
  });

  it("forces rebuild when the cache-root scan finds unbound raw paths", () => {
    const result = decideC0Reuse({
      sourceRoot: "/cache/canonical",
      source: identity(),
      final: identity(),
      replay: completeReplay(),
      rawInventoryClosed: false
    });

    expect(result.action).toBe("rebuild");
    expect(result.reasons).toContain("raw_inventory_not_closed");
  });

  it("accepts only a new, empty target root for rebuild", () => {
    const base = mkdtempSync(join(tmpdir(), "alaya-c0-decision-"));
    roots.push(base);
    const source = join(base, "canonical");
    const target = join(base, "final-new");
    mkdirSync(source);

    expect(() => assertFreshC0RebuildRoot({ sourceRoot: source, targetRoot: source })).toThrow(/differ/u);
    assertFreshC0RebuildRoot({ sourceRoot: source, targetRoot: target });
    mkdirSync(target);
    expect(() => assertFreshC0RebuildRoot({ sourceRoot: source, targetRoot: target })).toThrow(/not exist/u);
  });
});

function identity() {
  return {
    datasetRevision: "a".repeat(64),
    model: "gpt-5.4-mini",
    modelFamily: "gpt-5.4",
    requestProfile: "provider-default-v1",
    providerUrl: "https://provider.example/v1",
    systemPromptSha256: "b".repeat(64),
    cacheKeyAlgorithm: "sha256(model\\0requestProfile\\0systemPrompt\\0turnContent)",
    rawClosureSha256: "c".repeat(64),
    parserSemanticsSha256: "d".repeat(64),
    formationSemanticsSha256: "e".repeat(64),
    temporalSchemaRevision: "relation-assertion-v1"
  };
}

function completeReplay() {
  return {
    occurrenceCount: 2,
    accountedOccurrences: 2,
    elementCount: 2,
    accountedElements: 2,
    admitted: 1,
    deferred: 1,
    rejected: 0,
    invalid: 0,
    ledgerSha256: "1".repeat(64)
  };
}
