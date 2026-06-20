import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diffKpis } from "../../history/diff.js";
import {
  entrySlug,
  listEntries,
  policyShapeSlug,
  readEntry,
  readLatest,
  readPrevious,
  writeEntry,
  type HistoryLayout
} from "../../history/history.js";
import { KpiPayloadSchema, type KpiPayload } from "../../schema/kpi-schema.js";
import { renderFindings } from "../../reporting/report.js";
import { collectReleaseHardGates, releaseHardGateAllowsLatestPassing } from "../../gates/release-gates.js";
import {
  buildFullLongMemEvalPayload,
  buildLivePayload,
  buildLocomoPayload,
  buildPayload,
  passingQualityMetrics,
  writeBenchPointer,
  writePointerlessPayload
} from "./history-fixture.js";

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


  it("derives policy-shape slug discriminators without weakening legacy slugs", () => {
    const runAt = new Date("2026-05-14T10:30:45.000Z");
    expect(policyShapeSlug("stress")).toBe("policy-stress");
    expect(policyShapeSlug("chat")).toBe("policy-chat");
    expect(entrySlug(runAt, "abcdef0", "policy-stress"))
      .toBe("2026-05-14T103045Z-abcdef0-policy-stress");
    expect(entrySlug(runAt, "abcdef0", "policy-chat"))
      .toBe("2026-05-14T103045Z-abcdef0-policy-chat");
  });


  it("parses legacy KPI archives without policy_shape as stress", () => {
    const { policy_shape: _policyShape, ...legacyPayload } = buildPayload("abc1234");
    const parsed = KpiPayloadSchema.parse(legacyPayload);

    expect(parsed.policy_shape).toBe("stress");
  });


  it("parses legacy KPI archives without simulate_report as none", () => {
    const { simulate_report: _simulateReport, ...legacyPayload } = buildPayload("abc1234");
    const parsed = KpiPayloadSchema.parse(legacyPayload);

    expect(parsed.simulate_report).toBe("none");
  });


  it("writes kpi.json + report.md + sidecars and tracks latest run and passing pointers", async () => {
    const payload = buildPayload("ec44a05");
    const slug = "2026-05-14T100000Z-ec44a05";
    const entry = await writeEntry(layout, "self", slug, payload, "# report\n", null, {
      sidecars: [{ filename: "live-gates.json", contents: "{\"status\":\"pass\"}\n" }]
    });
    expect(entry.slug).toBe(slug);
    const writtenKpi = await readFile(entry.kpiPath, "utf8");
    expect(JSON.parse(writtenKpi).alaya_commit).toBe("ec44a05");
    expect(await readFile(entry.sidecarPaths["live-gates.json"]!, "utf8"))
      .toBe("{\"status\":\"pass\"}\n");
    const baseline = await readFile(
      path.join(root, "self", "latest-baseline.json"),
      "utf8"
    );
    expect(JSON.parse(baseline).slug).toBe(slug);
    const latestRun = await readFile(
      path.join(root, "self", "latest-run.json"),
      "utf8"
    );
    const latestPassing = await readFile(
      path.join(root, "self", "latest-passing.json"),
      "utf8"
    );
    expect(JSON.parse(latestRun).slug).toBe(slug);
    expect(JSON.parse(latestPassing).slug).toBe(slug);
  });


  it("orders same-day slugs by ISO timestamp, not by sha7", async () => {
    // Two runs on the same date; the sha7 chosen for the later run is
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


  it("keeps pointerless Tier 1 no-gate archives out of passing scan fallback", async () => {
    const stagedPublicSlug = "2026-05-14T100000Z-1111111";
    const liveNoGateSlug = "2026-05-14T110000Z-2222222";
    const legacySlug = "2026-05-14T120000Z-3333333";
    const stagedLocomoSlug = "2026-05-14T130000Z-4444444";
    const stagedPublic: KpiPayload = {
      ...buildFullLongMemEvalPayload("public", "1111111", 0.72),
      evaluated_count: 100,
      kpi: {
        ...buildFullLongMemEvalPayload("public", "1111111", 0.72).kpi,
        latency_ms_p95: 110,
        quality_metrics: passingQualityMetrics()
      }
    };

    await writePointerlessPayload(root, "public", stagedPublicSlug, stagedPublic);
    await writePointerlessPayload(root, "live", liveNoGateSlug, buildLivePayload("2222222"));
    await writePointerlessPayload(root, "self", legacySlug, buildPayload("3333333"));
    await writePointerlessPayload(
      root,
      "public-locomo",
      stagedLocomoSlug,
      buildLocomoPayload("4444444", 100, 100, 0.99)
    );

    expect(await readLatest(layout, "public", { pointerKind: "passing" })).toBeNull();
    expect(await readLatest(layout, "live", { pointerKind: "passing" })).toBeNull();
    expect(await readLatest(layout, "public-locomo", { pointerKind: "passing" })).toBeNull();
    expect((await readLatest(layout, "self", { pointerKind: "passing" }))?.alaya_commit)
      .toBe("3333333");
  });


  it("ignores polluted latest-passing pointers for ineligible v0.3.11 Tier 1 archives", async () => {
    const passingSlug = "2026-05-14T100000Z-0aaaaaa";
    const pollutedSlug = "2026-05-14T110000Z-0bbbbbb";
    const passing = KpiPayloadSchema.parse(
      buildFullLongMemEvalPayload("public", "0aaaaaa", 0.91)
    );
    const polluted: KpiPayload = {
      ...buildFullLongMemEvalPayload("public", "0bbbbbb", 0.95),
      sample_size: 100,
      evaluated_count: 100
    };

    await writeEntry(layout, "public", passingSlug, passing, "report", null);
    await writePointerlessPayload(root, "public", pollutedSlug, polluted);
    await writeBenchPointer(root, "public", "latest-passing.json", pollutedSlug);

    expect((await readLatest(layout, "public", { pointerKind: "passing" }))?.alaya_commit)
      .toBe("0aaaaaa");
    expect(
      (await readLatest(layout, "public", {
        split: "longmemeval-s",
        embeddingProvider: "none",
        pointerKind: "passing"
      }))?.alaya_commit
    ).toBe("0aaaaaa");
  });


  it("ignores polluted latest-passing pointers for staged v0.3.11 LoCoMo archives", async () => {
    const passingSlug = "2026-05-14T100000Z-3aaaaaa";
    const pollutedSlug = "2026-05-14T110000Z-3bbbbbb";
    const passing = KpiPayloadSchema.parse(buildLocomoPayload("3aaaaaa", 1982, 1982, 0.56));
    const polluted = KpiPayloadSchema.parse(buildLocomoPayload("3bbbbbb", 100, 100, 0.99));

    await writeEntry(layout, "public-locomo", passingSlug, passing, "report", null);
    await writePointerlessPayload(root, "public-locomo", pollutedSlug, polluted);
    await writeBenchPointer(root, "public-locomo", "latest-passing.json", pollutedSlug);

    expect((await readLatest(layout, "public-locomo", { pointerKind: "passing" }))?.alaya_commit)
      .toBe("3aaaaaa");
    expect(
      (await readLatest(layout, "public-locomo", {
        split: "locomo10",
        embeddingProvider: "none",
        pointerKind: "passing"
      }))?.alaya_commit
    ).toBe("3aaaaaa");
  });


  it("ignores polluted legacy baseline pointers for ineligible v0.3.11 Tier 1 archives", async () => {
    const passingSlug = "2026-05-14T100000Z-1aaaaaa";
    const pollutedSlug = "2026-05-14T110000Z-1bbbbbb";
    const passing = KpiPayloadSchema.parse(
      buildFullLongMemEvalPayload("public-crossquestion", "1aaaaaa", 0.91)
    );
    const polluted: KpiPayload = {
      ...buildFullLongMemEvalPayload("public-crossquestion", "1bbbbbb", 0.95),
      sample_size: 100,
      evaluated_count: 100
    };

    await writePointerlessPayload(root, "public-crossquestion", passingSlug, passing);
    await writePointerlessPayload(root, "public-crossquestion", pollutedSlug, polluted);
    await writeBenchPointer(
      root,
      "public-crossquestion",
      "latest-baseline.json",
      pollutedSlug
    );

    expect(
      (await readLatest(layout, "public-crossquestion", { pointerKind: "passing" }))
        ?.alaya_commit
    ).toBe("1aaaaaa");
  });


  it("ignores polluted live latest-passing pointers without live-gates proof", async () => {
    const noGateSlug = "2026-05-14T100000Z-2aaaaaa";

    await writePointerlessPayload(root, "live", noGateSlug, buildLivePayload("2aaaaaa"));
    await writeBenchPointer(root, "live", "latest-passing.json", noGateSlug);

    expect(await readLatest(layout, "live", { pointerKind: "passing" })).toBeNull();
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


  it("prefers latest-run.json pointer over directory listing when present", async () => {
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
    // writeEntry repointed the latest-run pointer to the latest write; readLatest should
    // honour the pointer rather than re-scan the directory.
    const latest = await readLatest(layout, "self");
    expect(latest?.alaya_commit).toBe("0bbbbbb");
  });

});
