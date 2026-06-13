import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import {
  readEntry,
  readEntryForDiff,
  readLatest,
  readPrevious,
  writeEntry,
  type HistoryLayout
} from "../../history/history.js";
import { buildPayload, plantSchemaInvalidArchive } from "./history-fixture.js";

describe("history archive schema-invalid baselines", () => {
  let layout: HistoryLayout;
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "bench-history-"));
    layout = { historyRoot: root };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("readEntry stays strict on a schema-invalid historical archive", async () => {
    const slug = "2026-05-31T003312Z-0ff0ff0";
    await plantSchemaInvalidArchive(root, slug);
    await expect(readEntry(layout, "self", slug)).rejects.toBeInstanceOf(ZodError);
  });

  it("readEntryForDiff degrades a schema-invalid archive to no-baseline with a warning", async () => {
    const slug = "2026-05-31T003312Z-0ff0ff0";
    await plantSchemaInvalidArchive(root, slug);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const result = await readEntryForDiff(layout, "self", slug);
      expect(result).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0]?.[0] ?? "");
      expect(message).toContain(slug);
      expect(message).toContain("latency_ms");
    } finally {
      warn.mockRestore();
    }
  });

  // @anchor read-entry-for-diff-lenient — a tightened KpiPayloadSchema must not
  // brick new runs over a pre-existing archive that violates the new
  // constraint; the diff is advisory and degrades to no-baseline.
  it("a new run still writes its archive when the prior baseline is schema-invalid", async () => {
    const staleSlug = "2026-05-31T003312Z-0ff0ff0";
    await plantSchemaInvalidArchive(root, staleSlug);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(readLatest(layout, "self", {})).resolves.toBeNull();
      const currentSlug = "2026-05-31T010000Z-feeded0";
      await expect(
        readPrevious(layout, "self", currentSlug)
      ).resolves.toBeNull();

      const payload = buildPayload("feeded0");
      const entry = await writeEntry(
        layout,
        "self",
        currentSlug,
        payload,
        "# report\n",
        null
      );
      expect(entry.slug).toBe(currentSlug);
      const written = JSON.parse(await readFile(entry.kpiPath, "utf8")) as {
        alaya_commit: string;
      };
      expect(written.alaya_commit).toBe("feeded0");
    } finally {
      warn.mockRestore();
    }
  });
});
