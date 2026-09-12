import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import { prepareBatchExtractionWorkset } from "../../../runs/extraction/fill/batch-workset.js";
import { computeExtractionTurnCacheKeys } from "../../../runs/compile-seed/cache/cache-key.js";
import { writeCachedExtraction } from "../../../runs/compile-seed/cache/cache-shard.js";
import {
  inspectTurnContentKeySpace,
  type LongMemEvalExtractionTurn
} from "../../../runs/extraction/turn-contents.js";
import type { PreparedExtractionFill } from "../../../runs/extraction/fill/fill-preparation.js";
import { buildExtractionFillQuestion, buildGroundedSignalResponse } from "./fixture.js";

const config = {
  model: "gemini-2.5-flash-lite", requestProfile: "provider-default-v1" as const,
  providerUrl: "https://fixture.invalid/v1", apiKey: null
};

function turn(text: string, id = "message-1"): LongMemEvalExtractionTurn {
  return { turnContent: text, turnMessages: [{ message_id: id, role: "user", content: text }] };
}

function prepared(turns: readonly LongMemEvalExtractionTurn[]): Pick<PreparedExtractionFill,
  "config" | "datasetRevision" | "executionExtractionTurns" | "occurrenceExtractionTurns"> {
  return { config, datasetRevision: "synthetic-revision", executionExtractionTurns: turns };
}

describe("fresh Batch source workset", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "batch-workset-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("shares duplicate request work while retaining distinct original message occurrences", () => {
    const first = turn("I moved to Berlin in March.", "one");
    const second = turn(first.turnContent, "two");
    const plan = prepareBatchExtractionWorkset({ cacheRoot: root, prepared: {
      ...prepared([first]), occurrenceExtractionTurns: [first, second]
    } });
    expect(plan.lines).toHaveLength(1);
    expect(plan.units).toHaveLength(2);
    expect(new Set(plan.units.map((unit) => unit.semanticKey)).size).toBe(1);
    expect(new Set(plan.lines[0]!.unitKeys).size).toBe(2);
    expect(plan.units.every((unit) => unit.binding.datasetRevision === "synthetic-revision")).toBe(true);
    expect(plan.lines[0]!.key).toBe(computeExtractionTurnCacheKeys(
      config.model, config.requestProfile, OFFICIAL_API_SYSTEM_PROMPT, first
    )[0]);
  });

  it("keeps canonical lines and source identities stable under source order and route changes", () => {
    const turns = [turn("I moved to Berlin in March.", "one"),
      turn("My favorite hobby is cycling.", "two")];
    const baseline = prepareBatchExtractionWorkset({ cacheRoot: root, prepared: prepared(turns) });
    const reordered = prepareBatchExtractionWorkset({ cacheRoot: root, prepared: {
      ...prepared([...turns].reverse()), config: { ...config, providerUrl: "https://other.invalid/v1" }
    } });
    expect(reordered.lines).toEqual(baseline.lines);
    expect(reordered.units).toEqual(baseline.units);
  });

  it("submits only the selected missing shard while retaining the full occurrence bindings", () => {
    const turns = [turn("I moved to Berlin in March.", "one"),
      turn("My favorite hobby is cycling.", "two")];
    const first = prepareBatchExtractionWorkset({ cacheRoot: root, prepared: prepared(turns) });
    const cached = first.requests[0]!;
    writeCachedExtraction(root, cached.line.key, {
      model: config.model, request_profile: config.requestProfile,
      cache_key: cached.line.key, extracted_at: "2026-09-12T00:00:00.000Z",
      raw_json: buildGroundedSignalResponse(cached.line.userPrompt)
    });
    const next = prepareBatchExtractionWorkset({ cacheRoot: root, prepared: prepared(turns) });
    expect(next.lines).toHaveLength(1);
    expect(next.cachedRequests.map((item) => item.line.key)).toEqual([cached.line.key]);
    expect(next.units).toEqual(first.units);
    const scoped = prepareBatchExtractionWorkset({ cacheRoot: root, prepared: prepared(turns),
      executionCacheKeys: new Set([next.lines[0]!.key]) });
    expect(scoped.requests).toHaveLength(1);
    expect(scoped.lines).toEqual(next.lines);
  });

  it("holds corrupt selected cache state and foreign selections instead of silently spending", () => {
    const source = prepared([turn("I moved to Berlin in March.")]);
    const first = prepareBatchExtractionWorkset({ cacheRoot: root, prepared: source });
    const line = first.lines[0]!;
    writeCachedExtraction(root, line.key, {
      model: config.model, request_profile: config.requestProfile,
      cache_key: line.key, extracted_at: "2026-09-12T00:00:00.000Z", raw_json: "{"
    });
    expect(() => prepareBatchExtractionWorkset({ cacheRoot: root, prepared: source }))
      .toThrow("is invalid");
    expect(() => prepareBatchExtractionWorkset({ cacheRoot: root, prepared: source,
      executionCacheKeys: new Set(["foreign"]) })).toThrow("outside the selected source window");
  });

  it("keeps zero-assertion requests local and refuses an incomplete occurrence inventory", () => {
    const empty = prepareBatchExtractionWorkset({ cacheRoot: root, prepared: prepared([turn("")]) });
    expect(empty.lines).toEqual([]);
    expect(empty.deterministicEmptyRequests).toHaveLength(1);
    expect(empty.units).toEqual([]);
    expect(() => prepareBatchExtractionWorkset({ cacheRoot: root, prepared: {
      ...prepared([turn("I moved to Berlin in March.")]), occurrenceExtractionTurns: []
    } })).toThrow("does not cover");
  });

  it("preserves repeated dataset rounds before request deduplication", () => {
    const questions = ["first", "second"].map((id) => buildExtractionFillQuestion(
      id, "I moved to Berlin in March.", "My favorite hobby is cycling."
    ));
    const inspected = inspectTurnContentKeySpace(questions);
    expect(inspected.turnOccurrences).toBe(4);
    expect(inspected.distinctExtractionTurns).toHaveLength(2);
    expect(inspected.occurrenceExtractionTurns).toHaveLength(4);
    const plan = prepareBatchExtractionWorkset({ cacheRoot: root, prepared: {
      ...prepared(inspected.distinctExtractionTurns),
      occurrenceExtractionTurns: inspected.occurrenceExtractionTurns
    } });
    expect(plan.units.length).toBeGreaterThan(plan.lines.length);
    expect(new Set(plan.units.map((unit) => unit.binding.occurrenceIdentity)).size)
      .toBe(plan.units.length);
  });
});
