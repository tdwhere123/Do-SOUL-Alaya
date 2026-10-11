import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OFFICIAL_API_SYSTEM_PROMPT, parseOfficialApiSourcePacketRequest, receiveOfficialApiSourcePacket } from "@do-soul/alaya-soul";
import { prepareSourceRequestWorkset } from "../../../runs/extraction/fill/source-request-workset.js";
import { computeExtractionTurnCacheKeys } from "../../../runs/compile-seed/cache/cache-key.js";
import { writeCachedExtraction } from "../../../runs/compile-seed/cache/cache-shard.js";
import { createCachingSignalExtractor } from "../../../runs/compile-seed/compile-seed-cache.js";
import { fixtureAttemptAuthority, writeExtractionCacheTestManifest } from "../extraction/extraction-cache-test-fixture.js";
import {
  inspectTurnContentKeySpace,
  type LongMemEvalExtractionTurn
} from "../../../runs/extraction/turn-contents.js";
import type { PreparedExtractionFill } from "../../../runs/extraction/fill/fill-preparation.js";
import { buildExtractionFillQuestion, groundedExtractor } from "./fixture.js";
import { EXTRACTION_OPEN_SEMANTICS_GENERATION } from "../../../runs/extraction/request-artifact.js";

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

  it("retains distinct question rounds, conditionals and assistant context before open semantic request planning", () => {
    const questions = [buildExtractionFillQuestion("questions", "Where is the atlas?", "When will Talia leave?")];
    const inspected = inspectTurnContentKeySpace(questions, undefined, true);
    expect(inspected.distinctExtractionTurns).toHaveLength(2);
    expect(inspected.distinctExtractionRequestCount).toBe(2);
    const source = turn("If Talia calls, Niko will leave. Talia placed an atlas on the desk. She then opened it.");
    const plan = prepareSourceRequestWorkset({ cacheRoot: root, prepared: {
      ...prepared([...inspected.distinctExtractionTurns, source]),
      config: { ...config, openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION }
    } });
    expect(plan.lines).toHaveLength(3);
    expect(plan.deterministicEmptyRequests).toEqual([]);
    const texts = plan.requests.flatMap((item) => item.request.source_assertions.map((row) => row.text));
    expect(texts).toEqual(expect.arrayContaining([
      "User: Where is the atlas?", "User: When will Talia leave?", "Assistant: Acknowledged.",
      "User: If Talia calls, Niko will leave.", "She then opened it."
    ]));
    expect(plan.units).toHaveLength(6);
    expect(plan.units.every((unit) => !("semanticKey" in unit))).toBe(true);
    expect(plan.lines.every((line) => JSON.parse(line.userPrompt).source_request.source_unit_contract === "source-semantic-units-v1")).toBe(true);
  });

  it("prepares legal requests beside complete sources over catalog capacity without inventing a key", () => {
    const source = (assistantCount: number, suffix: string): LongMemEvalExtractionTurn => {
      const user = Array(64).fill("Café α.").join(" ");
      const assistant = Array(assistantCount).fill("再次。").join(" ");
      return { turnContent: `${user} ${assistant}`, turnMessages: [
        { message_id: `user-${suffix}`, role: "user", content: user },
        { message_id: `assistant-${suffix}`, role: "assistant", content: assistant }
      ] };
    };
    const ready = source(64, "ready"), excess = source(65, "excess");
    const preparedSources = { ...prepared([ready, excess]),
      config: { ...config, sourcePacking: "complete-source" as const,
        openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION } };
    const plan = prepareSourceRequestWorkset({ cacheRoot: root, prepared: preparedSources });
    expect(plan.lines).toHaveLength(1);
    expect(plan.requests).toHaveLength(1);
    expect(plan.unsupportedSources).toMatchObject([{ messageIds: ["user-excess", "assistant-excess"],
      datasetRevision: "synthetic-revision", sourceUnitCount: 129,
      disposition: { status: "unsupported_source", assertion_count: 129,
        reason: { dimension: "assertions", actual: 129, limit: 128 } } }]);
    expect(plan.lines[0]!.key).toBe(computeExtractionTurnCacheKeys(config.model, config.requestProfile,
      plan.lines[0]!.systemPrompt, ready, "complete-source", undefined, EXTRACTION_OPEN_SEMANTICS_GENERATION)[0]);
    expect(computeExtractionTurnCacheKeys(config.model, config.requestProfile, plan.lines[0]!.systemPrompt,
      excess, "complete-source", undefined, EXTRACTION_OPEN_SEMANTICS_GENERATION)).toEqual([]);
  });

  it("shares duplicate request work while retaining distinct original message occurrences", () => {
    const first = turn("I moved to Berlin in March.", "one");
    const second = turn(first.turnContent, "two");
    const plan = prepareSourceRequestWorkset({ cacheRoot: root, prepared: {
      ...prepared([first]), occurrenceExtractionTurns: [first, second]
    } });
    expect(plan.lines).toHaveLength(1);
    expect(plan.units).toHaveLength(2);
    expect(new Set(plan.units.map((unit) => "semanticKey" in unit ? unit.semanticKey : undefined)).size).toBe(1);
    expect(new Set(plan.lines[0]!.unitKeys).size).toBe(2);
    expect(plan.units.every((unit) => "datasetRevision" in unit.binding && unit.binding.datasetRevision === "synthetic-revision")).toBe(true);
    expect(plan.lines[0]!.key).toBe(computeExtractionTurnCacheKeys(
      config.model, config.requestProfile, OFFICIAL_API_SYSTEM_PROMPT, first
    )[0]);
  });

  it("keeps canonical lines and source identities stable under source order and route changes", () => {
    const turns = [turn("I moved to Berlin in March.", "one"),
      turn("My favorite hobby is cycling.", "two")];
    const baseline = prepareSourceRequestWorkset({ cacheRoot: root, prepared: prepared(turns) });
    const reordered = prepareSourceRequestWorkset({ cacheRoot: root, prepared: {
      ...prepared([...turns].reverse()), config: { ...config, providerUrl: "https://other.invalid/v1" }
    } });
    expect(reordered.lines).toEqual(baseline.lines);
    expect(reordered.units).toEqual(baseline.units);
  });

  it("submits only the selected missing shard while retaining the full occurrence bindings", async () => {
    const turns = [turn("I moved to Berlin in March.", "one"),
      turn("My favorite hobby is cycling.", "two")];
    const first = prepareSourceRequestWorkset({ cacheRoot: root, prepared: prepared(turns) });
    const cached = first.requests[0]!;
    writeExtractionCacheTestManifest({ cacheRoot: root, model: config.model,
      providerUrl: config.providerUrl, requestProfile: config.requestProfile,
      systemPrompt: cached.line.systemPrompt });
    const extractor = createCachingSignalExtractor({
      cacheRoot: root, config, delegate: groundedExtractor(),
      ...fixtureAttemptAuthority({ cacheRoot: root, model: config.model,
        requestProfile: config.requestProfile })
    });
    await extractor.extract({
      systemPrompt: cached.line.systemPrompt, userPrompt: cached.line.userPrompt,
      sourceCorpus: cached.sourceCorpus
    });
    const next = prepareSourceRequestWorkset({ cacheRoot: root, prepared: prepared(turns) });
    expect(next.lines).toHaveLength(1);
    expect(next.cachedRequests.map((item) => item.line.key)).toEqual([cached.line.key]);
    expect(next.units).toEqual(first.units);
    const scoped = prepareSourceRequestWorkset({ cacheRoot: root, prepared: prepared(turns),
      executionCacheKeys: new Set([next.lines[0]!.key]) });
    expect(scoped.requests).toHaveLength(1);
    expect(scoped.lines).toEqual(next.lines);
  });

  it("holds corrupt selected cache state and foreign selections instead of silently spending", () => {
    const source = prepared([turn("I moved to Berlin in March.")]);
    const first = prepareSourceRequestWorkset({ cacheRoot: root, prepared: source });
    const line = first.lines[0]!;
    writeCachedExtraction(root, line.key, {
      model: config.model, request_profile: config.requestProfile,
      cache_key: line.key, extracted_at: "2026-09-12T00:00:00.000Z", raw_json: "{"
    });
    expect(() => prepareSourceRequestWorkset({ cacheRoot: root, prepared: source }))
      .toThrow("is invalid");
    expect(() => prepareSourceRequestWorkset({ cacheRoot: root, prepared: source,
      executionCacheKeys: new Set(["foreign"]) })).toThrow("outside the selected source window");
  });

  it("keeps zero-assertion requests local and refuses an incomplete occurrence inventory", () => {
    const empty = prepareSourceRequestWorkset({ cacheRoot: root, prepared: prepared([turn("")]) });
    expect(empty.lines).toEqual([]);
    expect(empty.deterministicEmptyRequests).toHaveLength(1);
    expect(empty.units).toEqual([]);
    expect(() => prepareSourceRequestWorkset({ cacheRoot: root, prepared: {
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
    const plan = prepareSourceRequestWorkset({ cacheRoot: root, prepared: {
      ...prepared(inspected.distinctExtractionTurns),
      occurrenceExtractionTurns: inspected.occurrenceExtractionTurns
    } });
    expect(plan.units.length).toBeGreaterThan(plan.lines.length);
    expect(new Set(plan.units.map((unit) => unit.binding.occurrenceIdentity)).size)
      .toBe(plan.units.length);
  });

  it("binds packet profile content and role-bearing message corpora through the same request-key owner", () => {
    const sourceInterpretationProfile = { contract: "source-interpretation-profile-v1" as const, description: "Event description",
      predicates: [{ symbol: "complete", meaning: "Complete a theme", governing_roles: [] }],
      roles: [{ symbol: "theme", meaning: "Thing completed" }] };
    const source = { turnContent: "I completed alpha.", turnMessages: [
      { message_id: "u1", role: "user" as const, content: "I completed alpha." },
      { message_id: "a1", role: "assistant" as const, content: "Acknowledged." }
    ] };
    const input = { ...prepared([source]), config: { ...config, sourceInterpretationProfile } };
    const workset = prepareSourceRequestWorkset({ cacheRoot: root, prepared: input });
    const item = workset.requests[0]!, request = parseOfficialApiSourcePacketRequest(JSON.parse(item.line.userPrompt));
    expect(item.line.key).toMatch(/^[a-f0-9]{64}$/u);
    expect(item.line.key).toBe(computeExtractionTurnCacheKeys(config.model, config.requestProfile, item.line.systemPrompt,
      source, undefined, sourceInterpretationProfile)[0]);
    expect(receiveOfficialApiSourcePacket('{"contract":"source-interpretation-response-v2","packet":null}', request,
      { sourceCorpus: item.units[0]!.sourceCorpus, artifactKey: "unbound", producerId: "control" }).status).toBe("empty");
    expect(() => receiveOfficialApiSourcePacket('{"contract":"source-interpretation-response-v2","packet":null}', request,
      { sourceCorpus: source.turnContent, artifactKey: "unbound", producerId: "control" })).toThrow(/generation/u);
    const changed = prepareSourceRequestWorkset({ cacheRoot: root, prepared: { ...input, config: { ...input.config,
      sourceInterpretationProfile: { ...sourceInterpretationProfile, description: "Changed meaning, identical symbols" } } } });
    expect(changed.lines[0]!.key).not.toBe(item.line.key);
    const empty = prepareSourceRequestWorkset({ cacheRoot: root, prepared: { ...input,
      executionExtractionTurns: [turn("")] } });
    expect(empty.lines).toEqual([]);
    expect(empty.deterministicEmptyRequests).toHaveLength(1);
  });
});
