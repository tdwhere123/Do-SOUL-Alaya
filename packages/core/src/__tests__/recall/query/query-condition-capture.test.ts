import { describe, expect, it } from "vitest";
import {
  hashConditionDigest,
  hashQueryCacheKey,
  QUERY_CONDITION_OPERATOR_ID,
  type QueryConditionPort
} from "@do-soul/alaya-protocol";
import {
  captureEffectiveAsOf,
  captureQueryCondition,
  createQueryConditionPort
} from "../../../recall/query/condition/query-condition-capture.js";
import {
  CLOCK_AS_OF,
  completeCondition,
  conditionDraft,
  countingClock,
  EXPLICIT_AS_OF,
  frozenClock,
  GENERATION_ID,
  testPin,
  testSha256
} from "./query-condition-test-fixtures.js";

describe("query condition capture", () => {
  it("captures default effective_as_of once from the injected clock", () => {
    const clock = countingClock();
    const receipt = captureQueryCondition(conditionDraft(), {
      sha256: testSha256(),
      now: clock.now,
      pin: testPin()
    });

    expect(receipt.condition.effective_as_of).toBe(CLOCK_AS_OF);
    expect(receipt.recorded_at).toBe(CLOCK_AS_OF);
    expect(clock.calls()).toBe(1);
  });

  it("keeps an explicit as-of and does not consult the clock", () => {
    const clock = countingClock("2026-08-16T23:59:59.000Z");
    const receipt = captureQueryCondition(
      conditionDraft({ effective_as_of: EXPLICIT_AS_OF }),
      { sha256: testSha256(), now: clock.now, pin: testPin() }
    );

    expect(receipt.condition.effective_as_of).toBe(EXPLICIT_AS_OF);
    expect(clock.calls()).toBe(0);
    expect(captureEffectiveAsOf(EXPLICIT_AS_OF, clock.now)).toBe(EXPLICIT_AS_OF);
    expect(clock.calls()).toBe(0);
  });

  it("replays the same condition_digest and cache key", () => {
    const sha256 = testSha256();
    const deps = { sha256, now: frozenClock(), pin: testPin() };
    const first = captureQueryCondition(conditionDraft({
      request_id: "req-1",
      trace_id: "trace-1",
      span_id: "span-1"
    }), deps);
    const second = captureQueryCondition(conditionDraft({
      request_id: "req-2",
      trace_id: "trace-9"
    }), deps);
    const expectedDigest = hashConditionDigest(completeCondition(), sha256);

    expect(first.identity).toBe(expectedDigest);
    expect(second.identity).toBe(first.identity);
    expect(first.query_cache_key).toBe(second.query_cache_key);
    expect(first.query_cache_key).toBe(hashQueryCacheKey({
      generation_id: GENERATION_ID,
      condition_digest: expectedDigest,
      query_operator_id: QUERY_CONDITION_OPERATOR_ID
    }, sha256));
  });

  it("preserves authorized_scopes order in condition_digest", () => {
    const sha256 = testSha256();
    const deps = { sha256, now: frozenClock(), pin: testPin() };
    const forward = captureQueryCondition(conditionDraft({
      authorized_scopes: ["workspace-1", "project-a"]
    }), deps);
    const reversed = captureQueryCondition(conditionDraft({
      authorized_scopes: ["project-a", "workspace-1"]
    }), deps);

    expect(forward.condition.authorized_scopes).toEqual(["workspace-1", "project-a"]);
    expect(forward.identity).not.toBe(reversed.identity);
    expect(forward.identity).toBe(hashConditionDigest(forward.condition, sha256));
  });

  it("implements QueryConditionPort over a pinned generation", () => {
    const port: QueryConditionPort = createQueryConditionPort({
      sha256: testSha256(),
      now: frozenClock(),
      pin: testPin()
    });
    const receipt = port.captureCondition(completeCondition());

    expect(receipt.generation_id).toBe(GENERATION_ID);
    expect(receipt.query_operator_id).toBe(QUERY_CONDITION_OPERATOR_ID);
    expect(receipt.governance_effect).toBe("none");
    expect(receipt.deletion_behavior).toBe("rebuildable");
    expect(receipt.consumer).toBe("attributed_activation");
  });

  it("fails closed when the pin workspace does not match", () => {
    const port = createQueryConditionPort({
      sha256: testSha256(),
      now: frozenClock(),
      pin: testPin({ workspace_id: "workspace-2" })
    });

    expect(() => port.captureCondition(completeCondition())).toThrow(/workspace/u);
  });
});
