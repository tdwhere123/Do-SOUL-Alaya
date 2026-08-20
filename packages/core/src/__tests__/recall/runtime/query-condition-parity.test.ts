import { describe, expect, it } from "vitest";
import {
  compareQueryConditionParity,
  queryConditionParityView
} from "../../../recall/runtime/query-condition-parity.js";
import { captureQueryCondition } from
  "../../../recall/query/condition/query-condition-capture.js";
import {
  CLOCK_AS_OF,
  conditionDraft,
  EXPLICIT_AS_OF,
  frozenClock,
  testPin,
  testSha256
} from "../query/query-condition-test-fixtures.js";

describe("query condition receipt/cache/worker parity", () => {
  it("matches direct and worker captures for a default as-of", () => {
    const deps = {
      sha256: testSha256(),
      now: frozenClock(),
      pin: testPin()
    };
    const direct = captureQueryCondition(conditionDraft(), deps);
    const worker = captureQueryCondition(conditionDraft(), deps);
    const view = queryConditionParityView(direct);

    expect(compareQueryConditionParity(direct, worker)).toBe(true);
    expect(view.effective_as_of).toBe(CLOCK_AS_OF);
    expect(view.condition_digest).toBe(direct.identity);
    expect(view.query_cache_key).toBe(direct.query_cache_key);
    expect(view.generation_id).toBe(direct.generation_id);
  });

  it("replays an explicit as-of even if the clock later moves", () => {
    const ticks = [CLOCK_AS_OF, "2026-08-16T01:00:00.000Z"];
    let index = 0;
    const now = () => ticks[Math.min(index++, ticks.length - 1)]!;
    const deps = { sha256: testSha256(), now, pin: testPin() };
    const first = captureQueryCondition(
      conditionDraft({ effective_as_of: EXPLICIT_AS_OF }),
      deps
    );
    const second = captureQueryCondition(
      conditionDraft({ effective_as_of: EXPLICIT_AS_OF }),
      deps
    );

    expect(first.condition.effective_as_of).toBe(EXPLICIT_AS_OF);
    expect(second.condition.effective_as_of).toBe(EXPLICIT_AS_OF);
    expect(compareQueryConditionParity(first, second)).toBe(true);
    expect(index).toBe(0);
  });
});
