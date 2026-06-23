import { describe, expect, it } from "vitest";
import { RuntimeEventNormalizerState } from "../../runtime/runtime-event-normalizer-state.js";

describe("RuntimeEventNormalizerState eviction", () => {
  it("bounds tracked sessions and evicts the oldest when the cap is exceeded", () => {
    const cap = 4;
    const state = new RuntimeEventNormalizerState(cap);

    for (let i = 0; i < cap + 3; i += 1) {
      state.reserveMessageDelta(`session-${i}`, 0);
    }

    expect(state.trackedKeyCount).toBe(cap);
    // The three oldest sessions (0,1,2) were evicted; their dedup slots are freed,
    // so a re-reserve at the same sequence succeeds again.
    expect(state.reserveMessageDelta("session-0", 0)).toBe(true);
    // The most recent sessions stay tracked: a duplicate reserve is rejected.
    expect(state.reserveMessageDelta("session-6", 0)).toBe(false);
  });

  it("counts a session once across both dedup maps", () => {
    const state = new RuntimeEventNormalizerState(8);

    state.reserveMessageDelta("session-1", 0);
    state.reserveSessionFinished("session-1");

    expect(state.trackedKeyCount).toBe(1);
  });

  it("drops a session from the tracker once both dedup maps are clear", () => {
    const state = new RuntimeEventNormalizerState(8);

    state.reserveMessageDelta("session-1", 7);
    expect(state.trackedKeyCount).toBe(1);

    state.releaseMessageDelta("session-1", 7);
    expect(state.trackedKeyCount).toBe(0);
  });

  it("keeps a session tracked while session-finished state outlives its message deltas", () => {
    const state = new RuntimeEventNormalizerState(8);

    state.reserveSessionFinished("session-1");
    state.reserveMessageDelta("session-1", 7);
    state.releaseMessageDelta("session-1", 7);

    expect(state.trackedKeyCount).toBe(1);
    state.clearSessionState("session-1");
    expect(state.trackedKeyCount).toBe(0);
  });
});
