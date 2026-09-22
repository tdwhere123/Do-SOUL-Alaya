import { expect, it } from "vitest";
import { SourceSemanticResourceLedger } from "@do-soul/alaya-protocol";
import { createSourceSemanticAccessPolicy } from "../../../recall/runtime/source-semantic-access.js";

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
