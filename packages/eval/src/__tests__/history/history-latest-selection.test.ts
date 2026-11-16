import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readLatest, type HistoryLayout } from "../../history/history.js";
import { latestPointerFilename, latestProviderPointerFilename } from "../../history/history-files.js";
import {
  buildPayload, plantSchemaInvalidArchive, writeBenchPointer, writePointerlessPayload
} from "./history-fixture.js";

const OLDER = "2026-05-14T080000Z-0aaaaaa";
const NEWER = "2026-05-14T090000Z-0bbbbbb";
const INVALID = "2026-05-14T100000Z-0cccccc";
const PROVIDER = "local-heuristic";

// Real archive reads distinguish pointer precedence from newest-first scanning.
describe("latest history selection", () => {
  let root: string;
  let layout: HistoryLayout;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "alaya-history-selection-"));
    layout = { historyRoot: root };
    await writePointerlessPayload(root, "self", OLDER, buildPayload("0aaaaaa"));
    await writePointerlessPayload(root, "self", NEWER, buildPayload("0bbbbbb"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  describe.each(["run", "passing"] as const)("%s selection", (pointerKind) => {
    it("prefers the selected general or provider pointer over a newer archive", async () => {
      await writeBenchPointer(root, "self", latestPointerFilename(pointerKind), OLDER);
      expect((await readLatest(layout, "self", { pointerKind }))?.alaya_commit).toBe("0aaaaaa");
      await writeBenchPointer(root, "self", latestPointerFilename(pointerKind), NEWER);
      await writeBenchPointer(root, "self", latestProviderPointerFilename(pointerKind, PROVIDER), OLDER);
      expect((await readLatest(layout, "self", { pointerKind, embeddingProvider: PROVIDER }))?.alaya_commit)
        .toBe("0aaaaaa");
    });

    it.each([
      { split: "synthetic" as const },
      { policyShape: "stress" as const },
      { simulateReport: "none" as const }
    ])("bypasses even unreadable pointers for cohort filter %j", async (filter) => {
      for (const filename of [latestPointerFilename(pointerKind), "latest-baseline.json",
        latestProviderPointerFilename(pointerKind, PROVIDER)]) {
        await writeFile(path.join(root, "self", filename), "not JSON", "utf8");
      }
      expect((await readLatest(layout, "self", {
        ...filter, pointerKind, embeddingProvider: PROVIDER
      }))?.alaya_commit).toBe("0bbbbbb");
      await expect(readLatest(layout, "self", { pointerKind })).rejects.toBeInstanceOf(SyntaxError);
    });
  });

  it("uses the legacy passing pointer only when no provider is selected", async () => {
    await writeBenchPointer(root, "self", "latest-baseline.json", OLDER);
    expect((await readLatest(layout, "self", { pointerKind: "passing" }))?.alaya_commit).toBe("0aaaaaa");
    expect((await readLatest(layout, "self", { pointerKind: "passing", embeddingProvider: PROVIDER }))?.alaya_commit)
      .toBe("0bbbbbb");
  });

  it.each([{}, { split: "synthetic" as const }])(
    "skips invalid archives and applies passing gates in the shared scan (%j)", async (filter) => {
      await writeFile(path.join(root, "self", NEWER, "findings.md"), "failed gate\n", "utf8");
      await plantSchemaInvalidArchive(root, INVALID);
      const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      expect((await readLatest(layout, "self", { ...filter, pointerKind: "run" }))?.alaya_commit).toBe("0bbbbbb");
      expect((await readLatest(layout, "self", { ...filter, pointerKind: "passing" }))?.alaya_commit).toBe("0aaaaaa");
      expect(warning).toHaveBeenCalledTimes(2);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining(INVALID));
    }
  );

  it("verifies evidence only for eligible passing candidates, never run candidates", async () => {
    await writePointerlessPayload(root, "self", NEWER, { ...buildPayload("0bbbbbb"), policy_shape: "chat" });
    const verified: string[] = [];
    layout = { ...layout, verifyLongMemEvalEvidence: async ({ payload }) => {
      verified.push(payload.alaya_commit);
      return null;
    } };
    expect((await readLatest(layout, "self", { policyShape: "stress", pointerKind: "run" }))?.alaya_commit)
      .toBe("0aaaaaa");
    expect(verified).toEqual([]);
    expect((await readLatest(layout, "self", { policyShape: "stress", pointerKind: "passing" }))?.alaya_commit)
      .toBe("0aaaaaa");
    expect(verified).toEqual(["0aaaaaa"]);
  });
});
