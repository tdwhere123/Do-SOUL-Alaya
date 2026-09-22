import { expect, it } from "vitest";
import { SourceSemanticResourceExhausted, SourceSemanticResourceLedger } from "@do-soul/alaya-protocol";
import { authorizeSemanticScope, createSourceSemanticAccessPolicy, sourceSemanticAccessInputIdentity } from "../../../recall/runtime/source-semantic-access.js";
import { BUDGET } from "./source-semantic-proof-fixture.js";

it("gives omitted optional access inputs the same identity as explicitly undefined inputs", () => {
  const input = { original_query: "orchid", budget: BUDGET, policy: "canonical-v1" as const };
  expect(sourceSemanticAccessInputIdentity(input)).toBe(sourceSemanticAccessInputIdentity({ ...input,
    query_semantics: undefined, source_id: undefined }));
  expect(sourceSemanticAccessInputIdentity({ ...input, source_id: "orchid-source" })).not.toBe(sourceSemanticAccessInputIdentity(input));
});

it("requires governed source scope even for unrestricted callers and preserves denied scope admission", () => {
  expect(() => authorizeSemanticScope("project", ["project"])).not.toThrow();
  expect(() => authorizeSemanticScope("global_core", null)).not.toThrow();
  for (const [scope, authorized] of [[null, null], [undefined, ["project"]], ["project", []], ["global_core", ["project"]]] as const) {
    expect(() => authorizeSemanticScope(scope, authorized)).toThrow();
  }
});

it("interleaves a late source hint with cursor exploration without dropping unknown or shared hashes", () => {
  const meter = new SourceSemanticResourceLedger({ work_units: 100_000, memory_bytes: 1_000_000 });
  const policy = createSourceSemanticAccessPolicy("orchid", undefined, "query-conditioned-v1", meter);
  const rows = [
    { identity: "a", source_hash: null }, { identity: "b", source_hash: "wrong" },
    { identity: "c", source_hash: "weak" }, { identity: "y", source_hash: "relevant" },
    { identity: "z", source_hash: "relevant" }
  ];
  const scheduled = policy.schedule(rows, [
    { digest: "weak", signal: { source_text_score: 0, interpretation_reading_score: 0 } },
    { digest: "relevant", signal: { source_text_score: 10, interpretation_reading_score: 0 } }
  ], meter);
  expect(scheduled.map((row) => row.identity)).toEqual(["y", "a", "z", "b", "c"]);
  expect(new Set(scheduled.map((row) => row.identity)).size).toBe(rows.length);
  expect(meter.spentWork).toBeGreaterThan(rows.length);
  expect(meter.spentBytes).toBeGreaterThan(0);
  const canonical = createSourceSemanticAccessPolicy("orchid", undefined, "canonical-v1", meter);
  expect(canonical.schedule(rows, [], meter)).toEqual(rows);
});

it("recomputes best shared hints and reading ties without carrying them into later schedules", () => {
  const meter = new SourceSemanticResourceLedger({ work_units: 100_000, memory_bytes: 1_000_000 });
  const policy = createSourceSemanticAccessPolicy("orchid", undefined, "query-conditioned-v1", meter);
  const rows = [{ identity: "a", source_hash: null }, { identity: "b", source_hash: "wrong" },
    { identity: "c", source_hash: "shared" }, { identity: "d", source_hash: "shared" },
    { identity: "e", source_hash: "distinct" }];
  const sources = [
    { digest: "shared", signal: { source_text_score: 0.4, interpretation_reading_score: 0.1 } },
    { digest: "shared", signal: { source_text_score: 0.2, interpretation_reading_score: 0.9 } },
    { digest: "shared", signal: { source_text_score: 0.4, interpretation_reading_score: 0.8 } },
    { digest: "distinct", signal: { source_text_score: 0.4, interpretation_reading_score: 0.9 } }
  ];
  expect(policy.schedule(rows, sources, meter).map(row => row.identity)).toEqual(["e", "a", "c", "b", "d"]);
  expect(policy.schedule(rows, [...sources].reverse(), meter).map(row => row.identity)).toEqual(["e", "a", "c", "b", "d"]);
  expect(policy.schedule(rows, [{ digest: "shared", signal: { source_text_score: 1, interpretation_reading_score: 0 } }], meter)
    .map(row => row.identity)).toEqual(["c", "a", "d", "b", "e"]);
  expect(policy.schedule(rows, [], meter).map(row => row.identity)).toEqual(["a", "b", "c", "d", "e"]);
});

it("reinterleaves the pending suffix and newly appended headers on each schedule", () => {
  const meter = new SourceSemanticResourceLedger({ work_units: 100_000, memory_bytes: 1_000_000 });
  const policy = createSourceSemanticAccessPolicy("orchid", undefined, "query-conditioned-v1", meter);
  const rows = ["a", "b", "c", "d", "e", "f"].map(identity => ({ identity, source_hash: identity }));
  const sources = [
    { digest: "d", signal: { source_text_score: 0.9, interpretation_reading_score: 0 } },
    { digest: "e", signal: { source_text_score: 0.8, interpretation_reading_score: 0 } },
    { digest: "f", signal: { source_text_score: 0.7, interpretation_reading_score: 0 } }
  ];
  const first = policy.schedule(rows, sources, meter);
  expect(first.map(row => row.identity)).toEqual(["d", "a", "e", "b", "f", "c"]);
  const pending = first.slice(2);
  expect(policy.schedule(pending, sources, meter).map(row => row.identity)).toEqual(["e", "f", "b", "c"]);
  expect(policy.schedule([...pending, { identity: "g", source_hash: "g" }], [
    ...sources, { digest: "g", signal: { source_text_score: 1, interpretation_reading_score: 0 } }
  ], meter).map(row => row.identity)).toEqual(["g", "e", "b", "f", "c"]);
  expect(pending.map(row => row.identity)).toEqual(["e", "b", "f", "c"]);
});

it("reuses retained headers without traversing their payload on repeated schedules", () => {
  const compileMeter = new SourceSemanticResourceLedger({ work_units: 100_000, memory_bytes: 1_000_000 });
  const policy = createSourceSemanticAccessPolicy("orchid", undefined, "query-conditioned-v1", compileMeter);
  const sources = [{ digest: "relevant", signal: { source_text_score: 1, interpretation_reading_score: 0 } }];
  const small = Object.freeze([{ identity: "a", source_hash: null, cursor: "small" },
    { identity: "b", source_hash: "relevant", cursor: "small" }].map(row => Object.freeze(row)));
  const large = Object.freeze(small.map(row => Object.freeze({ ...row, cursor: "retained cursor ".repeat(100_000) })));
  const smallMeter = new SourceSemanticResourceLedger({ work_units: 100_000, memory_bytes: 1_000_000 });
  const largeMeter = new SourceSemanticResourceLedger({ work_units: 100_000, memory_bytes: 1_000_000 });
  for (let round = 0; round < 3; round++) {
    const beforeWork = largeMeter.spentWork, beforeBytes = largeMeter.spentBytes;
    const smallSchedule = policy.schedule(small, sources, smallMeter), largeSchedule = policy.schedule(large, sources, largeMeter);
    expect(smallSchedule.map(row => row.identity)).toEqual(["b", "a"]);
    expect(largeSchedule[0]).toBe(large[1]);
    expect(largeSchedule[1]).toBe(large[0]);
    expect(largeSchedule).not.toBe(large);
    expect(largeMeter.spentWork).toBeGreaterThan(beforeWork);
    expect(largeMeter.spentBytes).toBeGreaterThan(beforeBytes);
    expect(largeMeter.spentWork).toBe(smallMeter.spentWork);
    expect(largeMeter.spentBytes).toBe(smallMeter.spentBytes);
  }
  expect(() => policy.schedule(large, sources, new SourceSemanticResourceLedger({ work_units: 0, memory_bytes: 1_000_000 })))
    .toThrow(SourceSemanticResourceExhausted);
  expect(() => policy.schedule(large, sources, new SourceSemanticResourceLedger({ work_units: 100_000, memory_bytes: 0 })))
    .toThrow(SourceSemanticResourceExhausted);
});
