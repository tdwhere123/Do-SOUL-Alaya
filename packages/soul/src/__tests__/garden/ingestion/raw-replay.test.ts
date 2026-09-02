import { describe, expect, it } from "vitest";
import {
  computeDerivedReplayIdentity,
  currentOfficialApiParserSemanticsVersion,
  digestRawJson,
  inspectImmutableRawJson,
  replayOfficialApiSignalsFromRaw
} from "../../../garden/ingestion/official-api/raw-replay.js";

const EMPTY = '{"signals":[]}';

describe("immutable raw replay", () => {
  it("binds a digest and refuses truncation, invalid JSON, and digest mismatch", () => {
    const inspected = inspectImmutableRawJson(EMPTY);
    expect(inspected.raw_signal_count).toBe(0);
    expect(inspected.raw_json_sha256).toBe(digestRawJson(EMPTY));
    expect(() => inspectImmutableRawJson("{")).toThrow(/not strict JSON/u);
    expect(() => inspectImmutableRawJson('{"signals":[{"x":1}')).toThrow(/truncated|not strict JSON/u);
    expect(() => replayOfficialApiSignalsFromRaw(EMPTY, "00".repeat(32))).toThrow(/digest mismatch/u);
    expect(replayOfficialApiSignalsFromRaw(EMPTY, inspected.raw_json_sha256)).toEqual([]);
  });

  it("changes derived identity when parser or projection versions change and keeps raw bytes", () => {
    const rawJsonSha256 = digestRawJson(EMPTY);
    const base = computeDerivedReplayIdentity({
      rawJsonSha256,
      parserSemanticsVersion: currentOfficialApiParserSemanticsVersion(),
      projectionVersion: "proj-v1",
      materializerVersion: "mat-v1",
      governanceVersion: "gov-v1"
    });
    const parserShift = computeDerivedReplayIdentity({
      rawJsonSha256,
      parserSemanticsVersion: `${currentOfficialApiParserSemanticsVersion()}-next`,
      projectionVersion: "proj-v1",
      materializerVersion: "mat-v1",
      governanceVersion: "gov-v1"
    });
    expect(parserShift).not.toBe(base);
    expect(digestRawJson(EMPTY)).toBe(rawJsonSha256);
  });
});
