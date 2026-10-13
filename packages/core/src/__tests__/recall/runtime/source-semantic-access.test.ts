import { expect, it } from "vitest";
import { SourceSemanticResourceExhausted, SourceSemanticResourceLedger } from "@do-soul/alaya-protocol";
import { authorizeSemanticScope, createSourceSemanticAccessPolicy, sourceSemanticAccessInputIdentity } from "../../../recall/runtime/source-semantic-access.js";
import { BUDGET } from "./source-semantic-proof-fixture.js";

it("gives omitted optional access inputs the same identity as explicitly undefined inputs", () => {
  const input = { original_query: "orchid", budget: BUDGET, policy: "canonical-v1" as const };
  expect(sourceSemanticAccessInputIdentity(input)).toBe(sourceSemanticAccessInputIdentity({ ...input,
    query_semantics: undefined, source_id: undefined, access_hint: undefined }));
  expect(sourceSemanticAccessInputIdentity({ ...input, source_id: "orchid-source" })).not.toBe(sourceSemanticAccessInputIdentity(input));
  const hinted = { ...input, policy: "query-conditioned-v1" as const, access_hint: "Harbor" };
  expect(sourceSemanticAccessInputIdentity(hinted)).not.toBe(sourceSemanticAccessInputIdentity({ ...hinted, access_hint: undefined }));
  expect(sourceSemanticAccessInputIdentity(hinted)).not.toBe(sourceSemanticAccessInputIdentity({ ...hinted, access_hint: "harbor" }));
});

it("uses a metered task hint only for navigation while keeping original-query source scores and ordering", () => {
  const budget = { work_units: 100_000, memory_bytes: 1_000_000 };
  const meter = new SourceSemanticResourceLedger(budget);
  const original = createSourceSemanticAccessPolicy("orchid", undefined, "query-conditioned-v1", meter);
  const hinted = createSourceSemanticAccessPolicy("orchid", undefined, "query-conditioned-v1", meter, "Harbor irrigation");
  const navigationMeter = new SourceSemanticResourceLedger(budget);
  expect(hinted.navigationQuery(navigationMeter)).toBe("Harbor irrigation");
  expect(navigationMeter.spentWork).toBeGreaterThan(0);
  expect(navigationMeter.spentBytes).toBeGreaterThan(0);
  expect(() => hinted.navigationQuery(new SourceSemanticResourceLedger({ work_units: 0, memory_bytes: 1000 })))
    .toThrow(SourceSemanticResourceExhausted);
  const sources = [{ identity: "a", text: "Harbor irrigation" }, { identity: "z", text: "orchid" }];
  const rows = sources.map(row => ({ identity: row.identity, signal: hinted.source(row.text, meter) }));
  const originalRows = sources.map(row => ({ identity: row.identity, signal: original.source(row.text, meter) }));
  expect(rows.map(row => row.signal)).toEqual(originalRows.map(row => row.signal));
  expect(rows[0]!.signal).not.toBeNull();
  expect(rows[1]!.signal).not.toBeNull();
  expect(rows[0]!.signal!.source_text_score).not.toBeNull();
  expect(rows[1]!.signal!.source_text_score).not.toBeNull();
  expect(rows[1]!.signal!.source_text_score!).toBeGreaterThan(rows[0]!.signal!.source_text_score!);
  expect(hinted.order(rows, meter).map(row => row.identity)).toEqual(["z", "a"]);
  expect(original.order(originalRows, meter).map(row => row.identity)).toEqual(["z", "a"]);
  expect(() => createSourceSemanticAccessPolicy("orchid", undefined, "canonical-v1", meter, "Harbor"))
    .toThrow(/canonical/u);
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
  policy.associateSourceHint("weak", { source_text_score: 0, interpretation_reading_score: 0 }, meter);
  policy.associateSourceHint("relevant", { source_text_score: 1, interpretation_reading_score: 0 }, meter);
  const scheduled = policy.schedule(rows, rows, meter);
  expect(scheduled.map((row) => row.identity)).toEqual(["y", "a", "z", "b", "c"]);
  expect(new Set(scheduled.map((row) => row.identity)).size).toBe(rows.length);
  expect(meter.spentWork).toBeGreaterThan(rows.length);
  expect(meter.spentBytes).toBeGreaterThan(0);
  const canonical = createSourceSemanticAccessPolicy("orchid", undefined, "canonical-v1", meter);
  canonical.associateSourceHint("relevant", { source_text_score: 1, interpretation_reading_score: 0 }, meter);
  expect(canonical.schedule(rows, rows, meter)).toEqual(rows);
});

it("charges lexical query navigation and interleaves nominees with ordinary cursor exploration", () => {
  const meter = new SourceSemanticResourceLedger({ work_units: 100_000, memory_bytes: 1_000_000 });
  const policy = createSourceSemanticAccessPolicy("orchid", undefined, "query-conditioned-v1", meter);
  const before = meter.spentWork;
  expect(policy.navigationQuery(meter)).toBe("orchid");
  expect(meter.spentWork).toBeGreaterThan(before);
  expect(() => policy.navigationQuery(new SourceSemanticResourceLedger({ work_units: 0, memory_bytes: 1000 })))
    .toThrow(SourceSemanticResourceExhausted);
  const exploration = [{ identity: "a", source_hash: null }, { identity: "b", source_hash: "observed" }];
  const rows = [{ identity: "y", source_hash: null, query_hint: true as const },
    { identity: "z", source_hash: null, query_hint: true as const }, ...exploration];
  policy.associateSourceHint("observed", { source_text_score: 1, interpretation_reading_score: 0 }, meter);
  expect(policy.schedule(rows, exploration, meter).map(row => row.identity)).toEqual(["y", "a", "z", "b"]);
  const canonical = createSourceSemanticAccessPolicy("orchid", undefined, "canonical-v1", meter);
  expect(canonical.navigationQuery(meter)).toBeNull();
  expect(canonical.schedule(rows, rows, meter)).toEqual(rows);
});

it("retains incrementally observed best shared hints and reading ties across schedules", () => {
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
  for (const source of sources.slice(0, 3)) policy.associateSourceHint(source.digest, source.signal, meter);
  expect(policy.schedule(rows, rows, meter).map(row => row.identity)).toEqual(["c", "a", "d", "b", "e"]);
  policy.associateSourceHint(sources[3]!.digest, sources[3]!.signal, meter);
  expect(policy.schedule(rows, rows, meter).map(row => row.identity)).toEqual(["e", "a", "c", "b", "d"]);
  for (const source of [...sources].reverse()) {
    const beforeWork = meter.spentWork, beforeBytes = meter.spentBytes;
    policy.associateSourceHint(source.digest, source.signal, meter);
    expect(meter.spentWork).toBeGreaterThan(beforeWork);
    expect(meter.spentBytes).toBeGreaterThan(beforeBytes);
  }
  expect(policy.schedule(rows, rows, meter).map(row => row.identity)).toEqual(["e", "a", "c", "b", "d"]);
  policy.associateSourceHint("shared", { source_text_score: 1, interpretation_reading_score: 0 }, meter);
  expect(policy.schedule(rows, rows, meter).map(row => row.identity)).toEqual(["c", "a", "d", "b", "e"]);
  const reversed = createSourceSemanticAccessPolicy("orchid", undefined, "query-conditioned-v1", meter);
  for (const source of [...sources].reverse()) reversed.associateSourceHint(source.digest, source.signal, meter);
  expect(reversed.schedule(rows, rows, meter).map(row => row.identity)).toEqual(["e", "a", "c", "b", "d"]);
});

it("keeps unknown and zero hints reachable without sharing associations between policy instances", () => {
  const meter = new SourceSemanticResourceLedger({ work_units: 100_000, memory_bytes: 1_000_000 });
  const policy = createSourceSemanticAccessPolicy("orchid", undefined, "query-conditioned-v1", meter);
  const rows = [{ identity: "a", source_hash: "unknown" }, { identity: "b", source_hash: "relevant" },
    { identity: "c", source_hash: null }];
  const unknown = Object.freeze({ source_text_score: null, interpretation_reading_score: 0 });
  policy.associateSourceHint("unknown", unknown, meter);
  expect(policy.schedule(rows, rows, meter).map(row => row.identity)).toEqual(["a", "b", "c"]);
  policy.associateSourceHint("unknown", { source_text_score: 0, interpretation_reading_score: 0 }, meter);
  expect(policy.schedule(rows, rows, meter).map(row => row.identity)).toEqual(["a", "b", "c"]);
  policy.associateSourceHint("relevant", { source_text_score: 0.8, interpretation_reading_score: 0 }, meter);
  policy.associateSourceHint("relevant", unknown, meter);
  expect(policy.schedule(rows, rows, meter).map(row => row.identity)).toEqual(["b", "a", "c"]);
  expect(unknown.source_text_score).toBeNull();
  const fresh = createSourceSemanticAccessPolicy("orchid", undefined, "query-conditioned-v1", meter);
  expect(fresh.schedule(rows, rows, meter).map(row => row.identity)).toEqual(["a", "b", "c"]);
  fresh.associateSourceHint("unknown", { source_text_score: 1, interpretation_reading_score: 0 }, meter);
  expect(fresh.schedule(rows, rows, meter).map(row => row.identity)).toEqual(["a", "b", "c"]);
  expect(policy.schedule(rows, rows, meter).map(row => row.identity)).toEqual(["b", "a", "c"]);
});

it("rejects an uncharged hint before it can affect subsequent scheduling", () => {
  const meter = new SourceSemanticResourceLedger({ work_units: 100_000, memory_bytes: 1_000_000 });
  const policy = createSourceSemanticAccessPolicy("orchid", undefined, "query-conditioned-v1", meter);
  const rows = [{ identity: "a", source_hash: null }, { identity: "b", source_hash: "relevant" }];
  const signal = { source_text_score: 1, interpretation_reading_score: 0 };
  for (const budget of [{ work_units: 0, memory_bytes: 1_000_000 }, { work_units: 100_000, memory_bytes: 0 }]) {
    expect(() => policy.associateSourceHint("relevant", signal, new SourceSemanticResourceLedger(budget)))
      .toThrow(SourceSemanticResourceExhausted);
    expect(policy.schedule(rows, rows, meter).map(row => row.identity)).toEqual(["a", "b"]);
  }
  policy.associateSourceHint("relevant", signal, meter);
  expect(policy.schedule(rows, rows, meter).map(row => row.identity)).toEqual(["b", "a"]);
});

it("preserves chronological exploration after consuming pairs and appending new headers", () => {
  const meter = new SourceSemanticResourceLedger({ work_units: 100_000, memory_bytes: 1_000_000 });
  const policy = createSourceSemanticAccessPolicy("orchid", undefined, "query-conditioned-v1", meter);
  const rows = ["a", "b", "c", "d", "e", "f"].map(identity => ({ identity, source_hash: identity }));
  const sources = [
    { digest: "d", signal: { source_text_score: 0.9, interpretation_reading_score: 0 } },
    { digest: "e", signal: { source_text_score: 0.8, interpretation_reading_score: 0 } },
    { digest: "f", signal: { source_text_score: 0.7, interpretation_reading_score: 0 } }
  ];
  for (const source of sources) policy.associateSourceHint(source.digest, source.signal, meter);
  const first = policy.schedule(rows, rows, meter);
  expect(first.map(row => row.identity)).toEqual(["d", "a", "e", "b", "f", "c"]);
  const pending = [rows[1]!, rows[2]!, rows[4]!, rows[5]!];
  expect(policy.schedule(pending, pending, meter).map(row => row.identity)).toEqual(["e", "b", "f", "c"]);
  policy.associateSourceHint("g", { source_text_score: 1, interpretation_reading_score: 0 }, meter);
  const appended = [...pending, { identity: "g", source_hash: "g" }];
  expect(policy.schedule(appended, appended, meter).map(row => row.identity)).toEqual(["g", "b", "e", "c", "f"]);
  expect(pending.map(row => row.identity)).toEqual(["b", "c", "e", "f"]);
});

it("uses a shared navigation and cursor identity once without wasting the next exploration turn", () => {
  const meter = new SourceSemanticResourceLedger({ work_units: 100_000, memory_bytes: 1_000_000 });
  const policy = createSourceSemanticAccessPolicy("orchid", undefined, "query-conditioned-v1", meter);
  const nominees = ["n1", "n2", "n3"].map(identity => ({ identity, source_hash: null, query_hint: true as const }));
  const ordinary = { identity: "a", source_hash: null };
  const scheduled = policy.schedule([...nominees, ordinary], [nominees[2]!, ordinary], meter);
  expect(scheduled.map(row => row.identity)).toEqual(["n1", "n3", "n2", "a"]);
  expect(scheduled[1]).toBe(nominees[2]);
  expect(policy.schedule(nominees, nominees, meter).map(row => row.identity)).toEqual(["n1", "n2", "n3"]);
  expect(policy.schedule(nominees, [], meter).map(row => row.identity)).toEqual(["n1", "n2", "n3"]);
});

it("reuses retained headers without traversing their payload on repeated schedules", () => {
  const compileMeter = new SourceSemanticResourceLedger({ work_units: 100_000, memory_bytes: 1_000_000 });
  const policy = createSourceSemanticAccessPolicy("orchid", undefined, "query-conditioned-v1", compileMeter);
  policy.associateSourceHint("relevant", { source_text_score: 1, interpretation_reading_score: 0 }, compileMeter);
  const small = Object.freeze([{ identity: "a", source_hash: null, cursor: "small" },
    { identity: "b", source_hash: "relevant", cursor: "small" }].map(row => Object.freeze(row)));
  const large = Object.freeze(small.map(row => Object.freeze({ ...row, cursor: "retained cursor ".repeat(100_000) })));
  const smallMeter = new SourceSemanticResourceLedger({ work_units: 100_000, memory_bytes: 1_000_000 });
  const largeMeter = new SourceSemanticResourceLedger({ work_units: 100_000, memory_bytes: 1_000_000 });
  for (let round = 0; round < 3; round++) {
    const beforeWork = largeMeter.spentWork, beforeBytes = largeMeter.spentBytes;
    const smallSchedule = policy.schedule(small, small, smallMeter), largeSchedule = policy.schedule(large, large, largeMeter);
    expect(smallSchedule.map(row => row.identity)).toEqual(["b", "a"]);
    expect(largeSchedule[0]).toBe(large[1]);
    expect(largeSchedule[1]).toBe(large[0]);
    expect(largeSchedule).not.toBe(large);
    expect(largeMeter.spentWork).toBeGreaterThan(beforeWork);
    expect(largeMeter.spentBytes).toBeGreaterThan(beforeBytes);
    expect(largeMeter.spentWork).toBe(smallMeter.spentWork);
    expect(largeMeter.spentBytes).toBe(smallMeter.spentBytes);
  }
  expect(() => policy.schedule(large, large, new SourceSemanticResourceLedger({ work_units: 0, memory_bytes: 1_000_000 })))
    .toThrow(SourceSemanticResourceExhausted);
  expect(() => policy.schedule(large, large, new SourceSemanticResourceLedger({ work_units: 100_000, memory_bytes: 0 })))
    .toThrow(SourceSemanticResourceExhausted);
});
