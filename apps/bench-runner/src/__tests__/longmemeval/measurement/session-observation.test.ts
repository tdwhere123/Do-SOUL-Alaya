import { afterAll, expect, it, vi } from "vitest";
const boundary = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  const { installStrictProviderFreeBoundary } = await import("../../support/strict-provider-free-boundary.js");
  return { safe: installProviderFreeBoundary(), strict: installStrictProviderFreeBoundary() };
});
afterAll(() => {
  expect(boundary.safe.violations).toEqual([]); expect(boundary.strict.forbidden).toEqual([]);
  boundary.strict.restore(); boundary.safe.restore();
});
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { assertLongMemEvalTimeline, describeLongMemEvalSessionTime } from "../../../datasets/longmemeval/ingestion/source-time.js";

it.each([
  ["2020/02/29", "2020-02-29T00:00:00.000Z", "day", "unspecified"],
  ["2020/02/29 (Sat) 14:05", "2020-02-29T14:05:00.000Z", "minute", "unspecified"],
  ["2020-02-29 14:05:06", "2020-02-29T14:05:06.000Z", "second", "unspecified"],
  ["2020-02-29T14:05:06.123Z", "2020-02-29T14:05:06.123Z", "millisecond", "explicit_utc"]
])("preserves session precision and timezone evidence for %s", (raw, normalized, precision, timezone) => {
  expect(describeLongMemEvalSessionTime(raw!)).toEqual({ raw, normalized, precision, timezone,
    level: "session", provenance: "longmemeval.haystack_dates", normalization: "utc_coordinate_not_event_time" });
});
it.each(["", "2021/02/29", "2020/13/01", "2020/01/01 25:00", "2020-01-01T00:00:00.000+01:00"])(
  "rejects invalid or unsupported source time %s instead of making it unknown", raw => {
    expect(() => describeLongMemEvalSessionTime(raw)).toThrow(/invalid LongMemEval timestamp/);
  });
it("rejects surplus dates before source import", () => {
  expect(() => assertLongMemEvalTimeline({ haystack_sessions: [[]], haystack_session_ids: ["session"],
    haystack_dates: ["2020/01/01", "2020/02/01"] })).toThrow(/equal lengths/);
});
it("carries new prepared session dates through SQLite and the compiled offline CLI without promoting support", { timeout: 180_000 }, async () => {
  const script = fileURLToPath(new URL("../../support/session-observation-proof.mjs", import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [script], { timeout: 170_000, env: process.env });
  expect(JSON.parse(stdout)).toEqual({ status: "passed", scratch_removed: true, observation: "session", support: "unknown", provider_calls: 0 });
});
