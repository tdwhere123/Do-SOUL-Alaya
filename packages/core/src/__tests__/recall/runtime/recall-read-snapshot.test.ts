import { describe, expect, it } from "vitest";
import {
  isActiveRecallReadCapability,
  withActiveRecallReadSnapshot,
  withRecallReadSnapshot,
  type ActiveRecallReadCapability,
  type RecallReadSnapshotPort
} from "../../../recall/runtime/recall-read-snapshot.js";

describe("withRecallReadSnapshot", () => {
  it("runs work without a snapshot port", async () => {
    await expect(withActiveRecallReadSnapshot(undefined, async (capability) => {
      expect(capability).toBeUndefined();
      return 7;
    })).resolves.toBe(7);
  });

  it("brands a capability only after begin and revokes it after commit", async () => {
    let captured: ActiveRecallReadCapability | undefined;
    const snapshot = createRecordingSnapshot([]);

    await withActiveRecallReadSnapshot(snapshot, async (capability) => {
      captured = capability;
      expect(isActiveRecallReadCapability(capability)).toBe(true);
    });

    expect(isActiveRecallReadCapability(captured)).toBe(false);
    expect(isActiveRecallReadCapability(Object.freeze({}))).toBe(false);
  });

  it("revokes the capability after rollback", async () => {
    let captured: ActiveRecallReadCapability | undefined;

    await expect(withActiveRecallReadSnapshot(
      createRecordingSnapshot([]), async (capability) => {
      captured = capability;
      throw new Error("read failed");
      }
    )).rejects.toThrow("read failed");

    expect(isActiveRecallReadCapability(captured)).toBe(false);
  });

  it("commits after the read path and rolls back on failure", async () => {
    const events: string[] = [];
    const snapshot = createRecordingSnapshot(events);

    await expect(withRecallReadSnapshot(snapshot, async () => {
      events.push("work");
      return "ok";
    })).resolves.toBe("ok");
    expect(events).toEqual(["begin", "work", "commit"]);

    events.length = 0;
    await expect(withRecallReadSnapshot(snapshot, async () => {
      events.push("work");
      throw new Error("read failed");
    })).rejects.toThrow("read failed");
    expect(events).toEqual(["begin", "work", "rollback"]);
  });

  it("isolates work onto the snapshot session before begin", async () => {
    const events: string[] = [];
    const snapshot: RecallReadSnapshotPort = {
      isolate: async (work) => {
        events.push("isolate");
        return await work();
      },
      beginDeferred: () => events.push("begin"),
      commit: () => events.push("commit"),
      rollback: () => events.push("rollback")
    };

    await expect(withRecallReadSnapshot(snapshot, async () => {
      events.push("work");
      return "ok";
    })).resolves.toBe("ok");
    expect(events).toEqual(["isolate", "begin", "work", "commit"]);
  });
});

function createRecordingSnapshot(events: string[]): RecallReadSnapshotPort {
  return {
    beginDeferred: () => events.push("begin"),
    commit: () => events.push("commit"),
    rollback: () => events.push("rollback")
  };
}
