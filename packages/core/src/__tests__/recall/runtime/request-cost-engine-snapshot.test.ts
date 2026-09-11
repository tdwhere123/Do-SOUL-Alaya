import { describe, expect, it } from "vitest";
import {
  retainedFieldLevels,
  snapshotRestoredEngineWork,
  thisRequestObservedWork
} from "../../../recall/runtime/request-cost-engine-snapshot.js";

const remaining = (units: number) => [{ units }];

describe("request-cost engine work snapshot", () => {
  it("bills solver and identity deltas, not retained length or leftover remaining bytes", () => {
    const restored = {
      solver_completed_work: 12,
      seen_identities: { length: 8 },
      remaining_memory_bytes: 40,
      remaining_work: remaining(5),
      pending_path_effects: { retained_bytes: 20 }
    };
    const before = snapshotRestoredEngineWork(restored, 1_000);
    expect(before.solver_completed_work).toBe(12);
    expect(before.charged_identities).toBe(8);
    expect(before.remaining_memory_bytes).toBe(980);

    const idle = thisRequestObservedWork(restored, { ...restored, remaining_memory_bytes: 980 }, 1_000);
    expect(idle.relaxations).toBe(0);
    expect(idle.state_creates).toBe(0);
    expect(idle.charged_retained_bytes).toBe(0);
    expect(idle.pending_work).toBe(5);

    const progressed = thisRequestObservedWork(restored, {
      solver_completed_work: 15,
      seen_identities: { length: 9 },
      remaining_memory_bytes: 900,
      remaining_work: remaining(2)
    }, 1_000);
    expect(progressed.relaxations).toBe(3);
    expect(progressed.state_creates).toBe(1);
    expect(progressed.charged_retained_bytes).toBe(80);
    expect(progressed.pending_work).toBe(2);
  });

  it("starts a first page from empty meters and treats remaining work as leftover", () => {
    const field = {
      solver_completed_work: 7,
      seen_identities: { length: 4 },
      remaining_memory_bytes: 750,
      remaining_work: remaining(9)
    };
    const delta = thisRequestObservedWork(undefined, field, 1_000);
    expect(delta.relaxations).toBe(7);
    expect(delta.state_creates).toBe(4);
    expect(delta.charged_retained_bytes).toBe(250);
    expect(delta.pending_work).toBe(9);
    expect(delta.state_creates).not.toBe(field.remaining_work[0]!.units);
    expect(retainedFieldLevels(field, 1_000)).toEqual({
      retained_states_current: 4,
      retained_bytes_current: 250
    });
  });

  it("does not bill a negative solver or identity delta when retained shrinks", () => {
    const restored = {
      solver_completed_work: 10,
      seen_identities: { length: 6 },
      remaining_memory_bytes: 500,
      remaining_work: remaining(1)
    };
    const delta = thisRequestObservedWork(restored, {
      solver_completed_work: 8,
      seen_identities: { length: 3 },
      remaining_memory_bytes: 500,
      remaining_work: remaining(1)
    }, 500);
    expect(delta.relaxations).toBe(0);
    expect(delta.state_creates).toBe(0);
    expect(delta.charged_retained_bytes).toBe(0);
  });
});
