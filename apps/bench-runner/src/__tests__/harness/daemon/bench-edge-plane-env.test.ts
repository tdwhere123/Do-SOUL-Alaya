import { describe, expect, it } from "vitest";
import {
  ENV_BOOLEAN_FALSE_TOKENS,
  ENV_BOOLEAN_TRUE_TOKENS,
  ENV_BOOLEAN_VOCABULARY_ERROR
} from "@do-soul/alaya-protocol";
import { shouldRunBenchEdgePlane } from "../../../harness/daemon/handle/daemon-handle-ops-support.js";

describe("shouldRunBenchEdgePlane env vocabulary", () => {
  it.each([...ENV_BOOLEAN_TRUE_TOKENS])("enables for %j", (token) => {
    expect(shouldRunBenchEdgePlane({ ALAYA_BENCH_RUN_EDGE_PLANE: token })).toBe(true);
  });

  it.each([...ENV_BOOLEAN_FALSE_TOKENS])("disables for %j", (token) => {
    expect(shouldRunBenchEdgePlane({ ALAYA_BENCH_RUN_EDGE_PLANE: token })).toBe(false);
  });

  it("rejects 2 instead of treating it as truthy", () => {
    expect(() => shouldRunBenchEdgePlane({ ALAYA_BENCH_RUN_EDGE_PLANE: "2" }))
      .toThrow(new RegExp(ENV_BOOLEAN_VOCABULARY_ERROR));
  });
});
