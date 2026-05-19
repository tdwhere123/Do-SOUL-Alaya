import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diffKpis } from "../diff.js";
import {
  entrySlug,
  listEntries,
  policyShapeSlug,
  readEntry,
  readLatest,
  readPrevious,
  writeEntry,
  type HistoryLayout
} from "../history.js";
import { KpiPayloadSchema, type KpiPayload } from "../kpi-schema.js";
import { renderFindings, renderReport } from "../report.js";

function buildPayload(commit: string): KpiPayload {
  return {
    bench_name: "self",
    split: "synthetic",
    run_at: "2026-05-14T10:00:00.000Z",
    alaya_commit: commit,
    alaya_version: "0.3.6",
    embedding_provider: "local-heuristic",
    chat_provider: "n/a",
    policy_shape: "stress",
    simulate_report: "none",
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

  it("writes kpi.json + report.md + sidecars and tracks the latest-baseline pointer", async () => {
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

  // @anchor write-entry-collision-test: see history.ts @write-entry-atomic.
  // Covers kpi.json + report.md + findings.md + pointer all surviving
  // the refused overwrite intact, not just report.md.
  it("refuses to overwrite an existing slug rather than clobbering the audit trail", async () => {
    const slug = "2026-05-14T120000Z-deadbef";
    await writeEntry(
      layout,
      "self",
      slug,
      buildPayload("deadbef"),
      "first report\n",
      "first findings\n"
    );
    await expect(
      writeEntry(
        layout,
        "self",
        slug,
        { ...buildPayload("deadbef"), alaya_commit: "0bbbbbb" } as KpiPayload,
        "second report\n",
        "second findings\n"
      )
    ).rejects.toThrow(/refusing to overwrite/);
    // Every artifact from the first write must survive.
    const firstKpi = JSON.parse(
      await readFile(path.join(root, "self", slug, "kpi.json"), "utf8")
    ) as { alaya_commit: string };
    expect(firstKpi.alaya_commit).toBe("deadbef");
    const firstReport = await readFile(
      path.join(root, "self", slug, "report.md"),
      "utf8"
    );
    expect(firstReport).toBe("first report\n");
    const firstFindings = await readFile(
      path.join(root, "self", slug, "findings.md"),
      "utf8"
    );
    expect(firstFindings).toBe("first findings\n");
    // Pointer still references the first slug.
    const pointer = JSON.parse(
      await readFile(path.join(root, "self", "latest-baseline.json"), "utf8")
    ) as { slug: string };
    expect(pointer.slug).toBe(slug);
  });

  it("does not publish the slug or latest pointer when a required sidecar write fails", async () => {
    const slug = "2026-05-15T130000Z-c0ffee0";

    await expect(
      writeEntry(layout, "live", slug, buildPayload("c0ffee0"), "report\n", null, {
        sidecars: [
          {
            filename: "live-gates.json",
            contents: undefined as unknown as string
          }
        ]
      })
    ).rejects.toThrow();

    expect(await listEntries(layout, "live")).toEqual([]);
    await expect(
      readFile(path.join(root, "live", "latest-baseline.json"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(path.join(root, "live", slug, "kpi.json"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  // @anchor orphan-staging-filter-test: see history.ts @write-entry-tmp-filter.
  // If a writeEntry is killed (SIGKILL / OOM) between mkdtemp and rename,
  // the .tmp-<slug>-<rand>/ staging directory is left on disk with a
  // parseable kpi.json. listEntries / readLatest must NOT return it.
  it("ignores orphan .tmp- staging directories left by interrupted writes", async () => {
    // Simulate an orphan staging dir matching the prefix we use.
    const orphanDir = path.join(
      root,
      "self",
      ".tmp-2026-05-14T999999Z-aaaaaaa-x7r2qp"
    );
    await mkdir(orphanDir, { recursive: true });
    await writeFile(
      path.join(orphanDir, "kpi.json"),
      JSON.stringify(buildPayload("aaaaaaa"), null, 2) + "\n",
      "utf8"
    );
    await writeFile(path.join(orphanDir, "report.md"), "orphan\n", "utf8");

    // Plus a real entry alongside.
    await writeEntry(
      layout,
      "self",
      "2026-05-14T100000Z-bbbbbbb",
      buildPayload("bbbbbbb"),
      "real\n",
      null
    );

    const slugs = await listEntries(layout, "self");
    expect(slugs).toEqual(["2026-05-14T100000Z-bbbbbbb"]);
    const latest = await readLatest(layout, "self");
    expect(latest?.alaya_commit).toBe("bbbbbbb");
  });

  // @anchor split-aware-readLatest-test: see history.ts @read-latest-split-aware
  it("readLatest with opts.split filters to entries of the matching split", async () => {
    const oraclePayload: KpiPayload = {
      ...buildPayload("0aaaaaa"),
      bench_name: "public",
      split: "longmemeval-oracle",
      sample_size: 500,
      evaluated_count: 500
    };
    const sPayload: KpiPayload = {
      ...buildPayload("0bbbbbb"),
      bench_name: "public",
      split: "longmemeval-s",
      sample_size: 500,
      evaluated_count: 50
    };
    await writeEntry(
      layout,
      "public",
      "2026-05-14T080000Z-0aaaaaa",
      oraclePayload,
      "report",
      null
    );
    await writeEntry(
      layout,
      "public",
      "2026-05-14T090000Z-0bbbbbb",
      sPayload,
      "report",
      null
    );
    // Without split filter, newest pointer wins.
    const newestAny = await readLatest(layout, "public");
    expect(newestAny?.alaya_commit).toBe("0bbbbbb");
    // With split filter, oracle goes back to 0aaaaaa even though 0bbbbbb is newer.
    const newestOracle = await readLatest(layout, "public", {
      split: "longmemeval-oracle"
    });
    expect(newestOracle?.alaya_commit).toBe("0aaaaaa");
    const newestS = await readLatest(layout, "public", { split: "longmemeval-s" });
    expect(newestS?.alaya_commit).toBe("0bbbbbb");
    // Split with no matching entries returns null, not the newest
    const newestGolden = await readLatest(layout, "public", { split: "golden" });
    expect(newestGolden).toBeNull();
  });

  it("readLatest can filter same-split LongMemEval archives by policy shape", async () => {
    const runAt = new Date("2026-05-14T10:30:45.000Z");
    const basePayload: KpiPayload = {
      ...buildPayload("abc1234"),
      bench_name: "public",
      split: "longmemeval-s",
      sample_size: 500,
      dataset: {
        name: "longmemeval_s",
        size: 500,
        source: "hf"
      }
    };
    await writeEntry(
      layout,
      "public",
      entrySlug(runAt, "abc1234", "policy-stress"),
      { ...basePayload, policy_shape: "stress" },
      "stress report",
      null
    );
    await writeEntry(
      layout,
      "public",
      entrySlug(runAt, "abc1234", "policy-chat"),
      { ...basePayload, policy_shape: "chat" },
      "chat report",
      null
    );

    const latestStress = await readLatest(layout, "public", {
      split: "longmemeval-s",
      policyShape: "stress"
    });
    const latestChat = await readLatest(layout, "public", {
      split: "longmemeval-s",
      policyShape: "chat"
    });

    expect(latestStress?.policy_shape).toBe("stress");
    expect(latestChat?.policy_shape).toBe("chat");
  });

  it("readLatest can filter same-split LongMemEval archives by simulate_report mode", async () => {
    const runAt = new Date("2026-05-14T10:30:45.000Z");
    const basePayload: KpiPayload = {
      ...buildPayload("abc1234"),
      bench_name: "public",
      split: "longmemeval-s",
      sample_size: 500,
      dataset: {
        name: "longmemeval_s",
        size: 500,
        source: "hf"
      }
    };
    await writeEntry(
      layout,
      "public",
      entrySlug(runAt, "abc1234", "policy-stress"),
      { ...basePayload, simulate_report: "none" },
      "cold report",
      null
    );
    await writeEntry(
      layout,
      "public",
      entrySlug(runAt, "abc1234", "policy-stress-report-mixed"),
      { ...basePayload, simulate_report: "mixed" },
      "warm report",
      null
    );

    const latestCold = await readLatest(layout, "public", {
      split: "longmemeval-s",
      policyShape: "stress",
      simulateReport: "none"
    });
    const latestWarm = await readLatest(layout, "public", {
      split: "longmemeval-s",
      policyShape: "stress",
      simulateReport: "mixed"
    });

    expect(latestCold?.simulate_report).toBe("none");
    expect(latestWarm?.simulate_report).toBe("mixed");
  });

  it("accepts public-multiturn archives and optional embedding diagnostic KPIs", async () => {
    const payload: KpiPayload = {
      ...buildPayload("abc1234"),
      bench_name: "public-multiturn",
      split: "longmemeval-s",
      embedding_provider: "yunwu:text-embedding-3-small",
      dataset: {
        name: "longmemeval_s:multiturn",
        size: 500,
        source: "github:xiaowu0162/LongMemEval"
      },
      sample_size: 500,
      evaluated_count: 25,
      kpi: {
        ...buildPayload("abc1234").kpi,
        r_at_5: 0.64,
        r_at_5_overall: 0.64,
        r_at_5_with_embedding_returned: 0.71,
        r_at_5_round_1: 0.52,
        r_at_5_round_2: 0.6,
        r_at_5_round_n: 0.64,
        multiturn_rounds: 3,
        provider_returned_rate: 0.8,
        provider_pending_rate: 0.12,
        provider_failed_rate: 0.08
      }
    };
    const parsedPayload = KpiPayloadSchema.parse(payload);
    expect(parsedPayload.bench_name).toBe("public-multiturn");

    const report = renderReport(parsedPayload, null, diffKpis(parsedPayload, null));
    expect(report).toContain("Public multi-turn archive");
    expect(report).toContain("Multi-turn R@5");
    expect(report).toContain("Embedding provider states");

    await writeEntry(
      layout,
      "public-multiturn",
      "2026-05-15T140000Z-abc1234",
      parsedPayload,
      report,
      null
    );
    const latest = await readLatest(layout, "public-multiturn", {
      split: "longmemeval-s"
    });
    expect(latest?.bench_name).toBe("public-multiturn");
    expect(latest?.kpi.r_at_5_with_embedding_returned).toBe(0.71);
  });

  it("flags LongMemEval-S disabled fallback reports below the target", () => {
    const payload: KpiPayload = {
      ...buildPayload("beef123"),
      bench_name: "public",
      split: "longmemeval-s",
      embedding_provider: "none",
      sample_size: 500,
      evaluated_count: 100,
      dataset: {
        name: "longmemeval_s",
        size: 500,
        source: "fixture"
      },
      kpi: {
        ...buildPayload("beef123").kpi,
        r_at_5: 0.38
      }
    };
    const parsedPayload = KpiPayloadSchema.parse(payload);
    const diff = diffKpis(parsedPayload, {
      ...payload,
      alaya_commit: "c0ffee0"
    });

    const report = renderReport(parsedPayload, parsedPayload, diff);
    expect(report).toContain("Worst verdict: **OK**");
    expect(report).toContain("LongMemEval-S disabled fallback target");
    expect(report).toContain("38.00% < target 40.00%");

    const findings = renderFindings(parsedPayload, diff);
    expect(findings).toContain("Absolute target gaps");
    expect(findings).toContain("current 38.00% < target 40.00%");
  });

  it("flags LongMemEval-S embedding full reports below the release target", () => {
    const payload: KpiPayload = {
      ...buildPayload("beef123"),
      bench_name: "public",
      split: "longmemeval-s",
      embedding_provider: "yunwu:text-embedding-3-small",
      sample_size: 500,
      evaluated_count: 500,
      dataset: {
        name: "longmemeval_s",
        size: 500,
        source: "fixture"
      },
      kpi: {
        ...buildPayload("beef123").kpi,
        r_at_5: 0.49
      }
    };
    const parsedPayload = KpiPayloadSchema.parse(payload);
    const diff = diffKpis(parsedPayload, {
      ...payload,
      alaya_commit: "c0ffee0"
    });

    const report = renderReport(parsedPayload, parsedPayload, diff);
    expect(report).toContain("LongMemEval-S embedding-500 release target");
    expect(report).toContain("49.00% < target 50.00%");
  });

  it("flags LoCoMo embedding full reports below the release target", () => {
    const payload: KpiPayload = {
      ...buildPayload("beef123"),
      bench_name: "public-locomo",
      split: "locomo10",
      embedding_provider: "yunwu:text-embedding-3-small",
      sample_size: 1982,
      evaluated_count: 1982,
      dataset: {
        name: "locomo10",
        size: 10,
        source: "fixture"
      },
      kpi: {
        ...buildPayload("beef123").kpi,
        r_at_5: 0.39
      }
    };
    const parsedPayload = KpiPayloadSchema.parse(payload);
    const diff = diffKpis(parsedPayload, {
      ...payload,
      alaya_commit: "c0ffee0"
    });

    const report = renderReport(parsedPayload, parsedPayload, diff);
    expect(report).toContain("LoCoMo embedding-full release target");
    expect(report).toContain("39.00% < target 40.00%");
  });
});
