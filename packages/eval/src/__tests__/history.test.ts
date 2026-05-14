import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  entrySlug,
  listEntries,
  readEntry,
  readLatest,
  readPrevious,
  writeEntry,
  type HistoryLayout
} from "../history.js";
import type { KpiPayload } from "../kpi-schema.js";

function buildPayload(commit: string): KpiPayload {
  return {
    bench_name: "self",
    split: "synthetic",
    run_at: "2026-05-14T10:00:00.000Z",
    alaya_commit: commit,
    alaya_version: "0.3.6",
    embedding_provider: "local-heuristic",
    chat_provider: "n/a",
    dataset: { name: "synthetic", size: 12, source: "internal" },
    sample_size: 10,
    evaluated_count: 10,
    harness_mode: "mcp_propose_review",
    kpi: {
      r_at_1: 0.6,
      r_at_5: 0.85,
      r_at_10: 0.9,
      latency_ms_p50: 60,
      latency_ms_p95: 110,
      token_saved_ratio_vs_full_prompt: 0.88,
      tier_distribution: { hot: 50, warm: 30, cold: 20 },
      degradation_reasons: {
        none: 80,
        warm_cascade_engaged: 12,
        cold_cascade_engaged: 8
      },
      per_scenario: []
    }
  };
}

describe("history archive", () => {
  let layout: HistoryLayout;
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "bench-history-"));
    layout = { historyRoot: root };
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("derives a sortable iso-timestamp slug for a run", () => {
    const slug = entrySlug(new Date("2026-05-14T10:30:45.000Z"), "abcdef0");
    expect(slug).toBe("2026-05-14T103045Z-abcdef0");
  });

  it("writes kpi.json + report.md and tracks the latest-baseline pointer", async () => {
    const payload = buildPayload("ec44a05");
    const slug = "2026-05-14T100000Z-ec44a05";
    const entry = await writeEntry(layout, "self", slug, payload, "# report\n", null);
    expect(entry.slug).toBe(slug);
    const writtenKpi = await readFile(entry.kpiPath, "utf8");
    expect(JSON.parse(writtenKpi).alaya_commit).toBe("ec44a05");
    const baseline = await readFile(
      path.join(root, "self", "latest-baseline.json"),
      "utf8"
    );
    expect(JSON.parse(baseline).slug).toBe(slug);
  });

  it("orders same-day slugs by ISO timestamp, not by sha7", async () => {
    // Two runs on the same date — the sha7 chosen for the later run is
    // lexicographically smaller, so a date-only slug would have put it
    // before the morning run. The ISO-T slug should keep them in the
    // correct chronological order regardless of sha7 ordering.
    await writeEntry(
      layout,
      "self",
      "2026-05-14T080000Z-ffeeddc",
      buildPayload("ffeeddc"),
      "report",
      null
    );
    await writeEntry(
      layout,
      "self",
      "2026-05-14T180000Z-0011223",
      buildPayload("0011223"),
      "report",
      null
    );
    const slugs = await listEntries(layout, "self");
    expect(slugs).toEqual([
      "2026-05-14T080000Z-ffeeddc",
      "2026-05-14T180000Z-0011223"
    ]);
    const latest = await readLatest(layout, "self");
    expect(latest?.alaya_commit).toBe("0011223");
    const previous = await readPrevious(layout, "self", "2026-05-14T180000Z-0011223");
    expect(previous?.alaya_commit).toBe("ffeeddc");
  });

  it("returns the newest slug from listEntries and tracks readLatest / readPrevious", async () => {
    await writeEntry(
      layout,
      "self",
      "2026-05-10T100000Z-aaaaaaa",
      buildPayload("aaaaaaa"),
      "report",
      null
    );
    await writeEntry(
      layout,
      "self",
      "2026-05-11T100000Z-bbbbbbb",
      buildPayload("bbbbbbb"),
      "report",
      null
    );
    await writeEntry(
      layout,
      "self",
      "2026-05-12T100000Z-ccccccc",
      buildPayload("ccccccc"),
      "report",
      null
    );
    const slugs = await listEntries(layout, "self");
    expect(slugs).toEqual([
      "2026-05-10T100000Z-aaaaaaa",
      "2026-05-11T100000Z-bbbbbbb",
      "2026-05-12T100000Z-ccccccc"
    ]);
    const latest = await readLatest(layout, "self");
    expect(latest?.alaya_commit).toBe("ccccccc");
    const previous = await readPrevious(layout, "self", "2026-05-12T100000Z-ccccccc");
    expect(previous?.alaya_commit).toBe("bbbbbbb");
  });

  it("returns empty / null when there are no entries", async () => {
    expect(await listEntries(layout, "public")).toEqual([]);
    expect(await readLatest(layout, "public")).toBeNull();
    expect(await readEntry(layout, "public", "missing-slug")).toBeNull();
  });

  it("writes findings.md only when the caller passes a non-null body", async () => {
    const slug = "2026-05-15T120000Z-fafafaf";
    const entry = await writeEntry(
      layout,
      "public",
      slug,
      buildPayload("fafafaf"),
      "report",
      "# findings\n- r@5 regressed\n"
    );
    const findings = await readFile(entry.findingsPath, "utf8");
    expect(findings).toContain("findings");
  });

  it("rejects slugs that contain path separators or parent-dir tokens", async () => {
    await expect(
      writeEntry(layout, "self", "../escape", buildPayload("abc"), "r", null)
    ).rejects.toThrow(/invalid slug/);
    await expect(
      writeEntry(layout, "self", "a/b", buildPayload("abc"), "r", null)
    ).rejects.toThrow(/invalid slug/);
  });

  it("prefers latest-baseline.json pointer over directory listing when present", async () => {
    await writeEntry(
      layout,
      "self",
      "2026-05-14T080000Z-0aaaaaa",
      buildPayload("0aaaaaa"),
      "report",
      null
    );
    await writeEntry(
      layout,
      "self",
      "2026-05-15T080000Z-0bbbbbb",
      buildPayload("0bbbbbb"),
      "report",
      null
    );
    // writeEntry repointed the pointer to the latest write; readLatest should
    // honour the pointer rather than re-scan the directory.
    const latest = await readLatest(layout, "self");
    expect(latest?.alaya_commit).toBe("0bbbbbb");
  });

  it("rejects slugs that violate the canonical ISO-T pattern", async () => {
    await expect(
      writeEntry(layout, "self", "2026-05-14-abcdef0", buildPayload("abc"), "r", null)
    ).rejects.toThrow(/must match/);
    await expect(
      writeEntry(layout, "self", "2026-05-14T080000Z-zzzzzzz", buildPayload("abc"), "r", null)
    ).rejects.toThrow(/must match/);
  });
});
