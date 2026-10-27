import { describe, expect, it } from "vitest";
import { orderNativeFieldAccess, type NativeRouteLane } from "../../../recall/runtime/native-route-opportunity.js";

function captured() {
  const lexical = [{ reference: "original-a", root_key: "a", native_rank: 3 },
    { reference: "original-b", root_key: "b", native_rank: 7 }];
  const timed = [{ reference: "time-b", root_key: "b", native_rank: 1 },
    { reference: "time-c", root_key: "c", native_rank: 5 }];
  const memory = [{ reference: "memory", root_key: "m", native_rank: 1 }];
  const lanes: NativeRouteLane[] = ["original-lexical", "original-vector", "hint-lexical", "hint-vector"].map((lane, i) => ({
    lane: lane as NativeRouteLane["lane"], scope: "original-query",
    ...(i === 0 ? { state: "exact-captured", occurrences: lexical } : { state: "measured-empty" }) }));
  return { lanes, memory: { lane: "memory-lexical" as const, scope: "original-query", state: "exact-captured" as const, occurrences: memory },
    question_time: { capture: { lane: "question-time-lexical" as const, scope: "original-query", state: "exact-captured" as const,
      occurrences: timed }, root_order: ["b", "c", "a"] },
    pool: ["a", "b", "c", "m"].map(record_id => ({ record_id, catalog_position: null })),
    acquired_root_keys: ["a", "b", "c", "m"],
    associations: [...lexical, ...timed, ...memory].map(row => ({ occurrence_reference: row.reference, root_key: row.root_key, record_id: row.root_key })),
    unvisited_sources: true };
}

describe("bounded question-time navigation", () => {
  it("keeps factual ranks separate while permuting source slots around memory", () => {
    const input = captured(), result = orderNativeFieldAccess(input);
    expect(result.status).toBe("ordered");
    if (result.status !== "ordered") throw new Error("expected total order");
    expect(result.record_ids).toEqual(["b", "m", "c", "a"]);
    expect(result.trace.map(row => [row.occurrence.reference, row.occurrence.native_rank]))
      .toEqual([["original-a", 3], ["memory", 1], ["original-b", 7], ["time-b", 1], ["time-c", 5]]);
    expect(result.trace.find(row => row.occurrence.reference === "time-b")?.decision).toBe("duplicate");
    expect(input.question_time.capture.occurrences[0]!.native_rank).toBe(1);
  });
  it("still rejects nonmonotonic factual ranks inside a restricted capture", () => {
    const input = captured(); input.question_time.capture.occurrences[1]!.native_rank = 1;
    expect(() => orderNativeFieldAccess(input)).toThrow("increasing factual ranks");
  });
  it.each([["b", "b", "a"], ["b", "missing", "a"], ["b", "m", "a"]])("rejects invalid source preference membership %s", (...keys) => {
    const input = captured(); input.question_time.root_order = keys;
    expect(() => orderNativeFieldAccess(input)).toThrow("distinct captured source roots");
  });
});
