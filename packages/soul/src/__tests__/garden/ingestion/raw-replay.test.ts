import { describe, expect, it } from "vitest";
import {
  computeDerivedReplayIdentity,
  currentOfficialApiParserSemanticsVersion,
  digestRawJson,
  inspectImmutableRawJson,
  replayOfficialApiSignalsFromRaw
} from "../../../garden/ingestion/official-api/raw-replay.js";

const EMPTY = '{"signals":[]}';
const VERSIONS = {
  parserSemanticsVersion: currentOfficialApiParserSemanticsVersion(),
  projectionVersion: "proj-v1",
  materializerVersion: "mat-v1",
  governanceVersion: "gov-v1"
} as const;

describe("immutable raw replay", () => {
  it("binds a digest and refuses truncation, invalid JSON, and digest mismatch", () => {
    const inspected = inspectImmutableRawJson(EMPTY);
    expect(inspected.raw_signal_count).toBe(0);
    expect(inspected.raw_json_sha256).toBe(digestRawJson(EMPTY));
    expect(() => inspectImmutableRawJson("{")).toThrow(/not strict JSON/u);
    expect(() => inspectImmutableRawJson('{"signals":[{"x":1}')).toThrow(/truncated|not strict JSON/u);
    expect(() => replayOfficialApiSignalsFromRaw(EMPTY, "00".repeat(32), VERSIONS))
      .toThrow(/digest mismatch/u);
    const replayed = replayOfficialApiSignalsFromRaw(EMPTY, inspected.raw_json_sha256, VERSIONS);
    expect(replayed.signals).toEqual([]);
    expect(replayed.derivedIdentity).toBe(computeDerivedReplayIdentity({
      rawJsonSha256: inspected.raw_json_sha256,
      ...VERSIONS
    }));
  });

  it("changes derived identity when parser or materializer versions change and keeps raw bytes", () => {
    const rawJsonSha256 = digestRawJson(EMPTY);
    const base = computeDerivedReplayIdentity({
      rawJsonSha256,
      ...VERSIONS
    });
    const parserShift = computeDerivedReplayIdentity({
      rawJsonSha256,
      ...VERSIONS,
      parserSemanticsVersion: `${VERSIONS.parserSemanticsVersion}-next`
    });
    const materializerShift = computeDerivedReplayIdentity({
      rawJsonSha256,
      ...VERSIONS,
      materializerVersion: `${VERSIONS.materializerVersion}-next`
    });
    const replayed = replayOfficialApiSignalsFromRaw(EMPTY, rawJsonSha256, {
      ...VERSIONS,
      materializerVersion: `${VERSIONS.materializerVersion}-next`
    });
    expect(parserShift).not.toBe(base);
    expect(materializerShift).not.toBe(base);
    expect(replayed.derivedIdentity).toBe(materializerShift);
    expect(digestRawJson(EMPTY)).toBe(rawJsonSha256);
  });
});
