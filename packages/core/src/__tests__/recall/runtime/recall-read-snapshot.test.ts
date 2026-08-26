import { describe, expect, it } from "vitest";
import {
  withRecallReadSnapshot,
  type RecallReadSnapshotPort
} from "../../../recall/runtime/recall-read-snapshot.js";

describe("withRecallReadSnapshot", () => {
  it("runs work without a snapshot port", async () => {
    await expect(withRecallReadSnapshot(undefined, async () => 7)).resolves.toBe(7);
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
