import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeHistoryEntry } from "../../history/history-entry-write.js";
import { buildPayload } from "./history-fixture.js";

describe("history entry staging cleanup", () => {
  it("preserves identity and cleanup failures together", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "history-entry-cleanup-"));
    const sourcePath = path.join(root, "diagnostics.json.gz");
    await writeFile(sourcePath, "actual diagnostics", "utf8");
    const cleanupError = new Error("injected staging cleanup failure");

    try {
      const failure = await writeHistoryEntry({
        layout: { historyRoot: root },
        benchName: "self",
        slug: "2026-05-15T134000Z-c0ffee0",
        payload: buildPayload("c0ffee0"),
        report: "report\n",
        findings: null,
        options: {
          fileSidecars: [{
            filename: "longmemeval-diagnostics.json.gz",
            sourcePath,
            identity: {
              sha256: createHash("sha256").update("different").digest("hex"),
              bytes: Buffer.byteLength("different")
            }
          }]
        },
        entryAllowsPassing: async () => false,
        operations: {
          removeStaging: async () => { throw cleanupError; }
        }
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toEqual([
        expect.objectContaining({ message: "history file sidecar identity mismatch" }),
        cleanupError
      ]);
      expect((failure as AggregateError).cause)
        .toMatchObject({ message: "history file sidecar identity mismatch" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
