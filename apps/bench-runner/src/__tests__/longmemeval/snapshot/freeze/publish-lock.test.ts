import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withSnapshotPublishLock } from
  "../../../../runs/snapshot/freeze/publish-lock.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

describe("snapshot publish lock", () => {
  it("rejects an overlapping publisher until the full first callback exits", async () => {
    const snapshotOut = await temporarySnapshotPath();
    let enterFirst!: () => void;
    let releaseFirst!: () => void;
    const entered = new Promise<void>((resolve) => { enterFirst = resolve; });
    const released = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = withSnapshotPublishLock(snapshotOut, async () => {
      enterFirst();
      await released;
    });
    await entered;

    await expect(withSnapshotPublishLock(snapshotOut, async () => undefined))
      .rejects.toThrow(/snapshot publish is already in progress/u);

    releaseFirst();
    await first;
    await expect(withSnapshotPublishLock(snapshotOut, async () => "reused"))
      .resolves.toBe("reused");
  });

  it("releases the durable lock when publication throws", async () => {
    const snapshotOut = await temporarySnapshotPath();

    await expect(withSnapshotPublishLock(snapshotOut, async () => {
      throw new Error("publication failed");
    })).rejects.toThrow(/publication failed/u);

    await expect(withSnapshotPublishLock(snapshotOut, async () => "recovered"))
      .resolves.toBe("recovered");
  });
});

async function temporarySnapshotPath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "snapshot-publish-lock-"));
  roots.push(root);
  return join(root, "nested", "snapshot.db");
}
