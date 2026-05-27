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
import { collectReleaseHardGates, releaseHardGateAllowsLatestPassing } from "../release-gates.js";

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

function passingQualityMetrics(): NonNullable<KpiPayload["kpi"]["quality_metrics"]> {
  return {
    schema_version: "bench-quality-metrics.v1",
    non_monotonic_rate: 0,
    non_monotonic_count: 0,
    non_monotonic_denominator: 100,
    budget_drop_distribution: {
      max_entries: {
        count: 0,
        share: 0,
        denominator: 100
      }
    },
    high_lexical_demoted_rate: 0,
    high_lexical_demoted_count: 0,
    high_lexical_demoted_denominator: 0,
    candidate_absent_count: 0,
    candidate_absent_denominator: 100,
    no_gold_count: 0,
    no_gold_denominator: 100,
    evidence_stream_gold_delivery_rate: 0.2,
    evidence_stream_gold_delivery_count: 20,
    evidence_stream_gold_delivery_denominator: 100,
    path_stream_top10_rate: 0.12,
    path_stream_top10_count: 12,
    path_stream_top10_denominator: 100,
    miss_distribution: {}
  };
}

function perCallStat(value: number) {
  return { mean: value, p50: value, p95: value, max: value };
}

// @anchor seed-extraction-release-blocker
// Release-grade LongMemEval archives require seed_extraction_path provenance
// per finding B0-1; missing the field on these benches is treated as
// degraded and blocked from latest_passing.
function cleanSeedExtractionPath(): NonNullable<
  KpiPayload["kpi"]["seed_extraction_path"]
> {
  return {
    path: "official_api_compile",
    cache_hits: 276,
    llm_calls: 0,
    offline_fallbacks: 0,
    live_extraction_failures: 0,
    cached_extraction_failures: 0,
    facts_produced: 1872,
    signals_dropped: 4,
    parse_dropped: 3,
    compile_overflow_dropped: 0
  };
}

function buildFullLongMemEvalPayload(
  benchName: "public" | "public-multiturn" | "public-crossquestion",
  commit: string,
  rAt5: number
): KpiPayload {
  return {
    ...buildPayload(commit),
    alaya_version: "0.3.11",
    bench_name: benchName,
    split: "longmemeval-s",
    embedding_provider: "none",
    dataset: {
      name:
        benchName === "public"
          ? "longmemeval_s"
          : benchName === "public-multiturn"
            ? "longmemeval_s:multiturn"
            : "longmemeval_s:crossquestion",
      size: 500,
      source: "fixture"
    },
    sample_size: 500,
    evaluated_count: 500,
    kpi: {
      ...buildPayload(commit).kpi,
      r_at_5: rAt5,
      latency_ms_p95: 120,
      quality_metrics: passingQualityMetrics(),
      seed_extraction_path: cleanSeedExtractionPath()
    }
  };
}

function buildLivePayload(commit: string): KpiPayload {
  return {
    ...buildPayload(commit),
    alaya_version: "0.3.11",
    bench_name: "live",
    split: "strict-real",
    dataset: {
      name: "alaya-live-strict-real",
      size: 500,
      source: ".do-it/checks/alaya-live/main-check.json#run-1"
    },
    sample_size: 500,
    evaluated_count: 500,
    harness_mode: "live_strict_real"
  };
}

function buildLocomoPayload(
  commit: string,
  sampleSize: number,
  evaluatedCount: number,
  rAt5: number
): KpiPayload {
  return {
    ...buildPayload(commit),
    alaya_version: "0.3.11",
    bench_name: "public-locomo",
    split: "locomo10",
    embedding_provider: "none",
    dataset: {
      name: "locomo10",
      size: 10,
      source: "fixture"
    },
    sample_size: sampleSize,
    evaluated_count: evaluatedCount,
    kpi: {
      ...buildPayload(commit).kpi,
      r_at_5: rAt5,
      latency_ms_p95: 110
    }
  };
}

async function writePointerlessPayload(
  historyRoot: string,
  benchName: KpiPayload["bench_name"],
  slug: string,
  payload: KpiPayload,
  findingsMarkdown: string | null = null
): Promise<void> {
  const entryRoot = path.join(historyRoot, benchName, slug);
  await mkdir(entryRoot, { recursive: true });
  await writeFile(path.join(entryRoot, "kpi.json"), JSON.stringify(payload, null, 2) + "\n", "utf8");
  await writeFile(path.join(entryRoot, "report.md"), "report\n", "utf8");
  if (findingsMarkdown !== null) {
    await writeFile(path.join(entryRoot, "findings.md"), findingsMarkdown, "utf8");
  }
}

async function writeBenchPointer(
  historyRoot: string,
  benchName: KpiPayload["bench_name"],
  filename: string,
  slug: string
): Promise<void> {
  await writeFile(
    path.join(historyRoot, benchName, filename),
    JSON.stringify({ slug, kpi_path: path.join(slug, "kpi.json") }, null, 2) + "\n",
    "utf8"
  );
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

  it("keeps latest-run and latest-passing split when a later run fails", async () => {
    const passingSlug = "2026-05-14T080000Z-0aaaaaa";
    const failingSlug = "2026-05-15T080000Z-0bbbbbb";
    await writeEntry(
      layout,
      "self",
      passingSlug,
      buildPayload("0aaaaaa"),
      "report",
      null
    );
    await writeEntry(
      layout,
      "self",
      failingSlug,
      buildPayload("0bbbbbb"),
      "report",
      "# findings\n- regression\n"
    );

    expect((await readLatest(layout, "self"))?.alaya_commit).toBe("0bbbbbb");
    expect((await readLatest(layout, "self", { pointerKind: "passing" }))?.alaya_commit)
      .toBe("0aaaaaa");
    expect(
      JSON.parse(await readFile(path.join(root, "self", "latest-run.json"), "utf8")).slug
    ).toBe(failingSlug);
    expect(
      JSON.parse(await readFile(path.join(root, "self", "latest-passing.json"), "utf8")).slug
    ).toBe(passingSlug);
    expect(
      JSON.parse(await readFile(path.join(root, "self", "latest-baseline.json"), "utf8")).slug
    ).toBe(passingSlug);
  });

  it.each([
    ["public-multiturn" as const, "longmemeval_multiturn_500_embedding_off_r_at_5"],
    ["public-crossquestion" as const, "longmemeval_crossquestion_500_embedding_off_r_at_5"]
  ])(
    "keeps latest-passing on the prior run when a full %s archive misses the v0.3.11 ship gate",
    async (benchName, expectedGateId) => {
      const passingSlug = "2026-05-14T080000Z-0aaaaaa";
      const failingSlug = "2026-05-15T080000Z-0bbbbbb";
      const passing = KpiPayloadSchema.parse(
        buildFullLongMemEvalPayload(benchName, "0aaaaaa", 0.91)
      );
      const failing = KpiPayloadSchema.parse(
        buildFullLongMemEvalPayload(benchName, "0bbbbbb", 0.12)
      );

      await writeEntry(layout, benchName, passingSlug, passing, "report", null);
      await writeEntry(layout, benchName, failingSlug, failing, "report", null);

      expect(collectReleaseHardGates(failing)).toContainEqual(
        expect.objectContaining({
          id: expectedGateId,
          current: 0.12,
          target: 0.9,
          passed: false
        })
      );
      expect((await readLatest(layout, benchName))?.alaya_commit).toBe("0bbbbbb");
      expect((await readLatest(layout, benchName, { pointerKind: "passing" }))?.alaya_commit)
        .toBe("0aaaaaa");
      expect(
        JSON.parse(await readFile(path.join(root, benchName, "latest-run.json"), "utf8")).slug
      ).toBe(failingSlug);
      expect(
        JSON.parse(await readFile(path.join(root, benchName, "latest-passing.json"), "utf8")).slug
      ).toBe(passingSlug);
      expect(
        JSON.parse(await readFile(path.join(root, benchName, "latest-baseline.json"), "utf8")).slug
      ).toBe(passingSlug);
    }
  );

  it("keeps latest-passing on the prior run when a non-full Tier 1 archive has no executable v0.3.11 gate", async () => {
    const passingSlug = "2026-05-14T080000Z-0aaaaaa";
    const limitedSlug = "2026-05-15T080000Z-0bbbbbb";
    const passing = KpiPayloadSchema.parse(
      buildFullLongMemEvalPayload("public-multiturn", "0aaaaaa", 0.91)
    );
    const limited = KpiPayloadSchema.parse({
      ...buildFullLongMemEvalPayload("public-multiturn", "0bbbbbb", 1),
      evaluated_count: 20
    });

    await writeEntry(layout, "public-multiturn", passingSlug, passing, "report", null);
    await writeEntry(layout, "public-multiturn", limitedSlug, limited, "report", null);

    expect(collectReleaseHardGates(limited)).toEqual([]);
    expect(releaseHardGateAllowsLatestPassing(limited)).toBe(false);
    expect(renderFindings(limited, diffKpis(limited, null))).toBeNull();
    expect((await readLatest(layout, "public-multiturn"))?.alaya_commit).toBe("0bbbbbb");
    expect((await readLatest(layout, "public-multiturn", { pointerKind: "passing" }))?.alaya_commit)
      .toBe("0aaaaaa");
    expect(
      JSON.parse(await readFile(path.join(root, "public-multiturn", "latest-run.json"), "utf8"))
        .slug
    ).toBe(limitedSlug);
    expect(
      JSON.parse(
        await readFile(path.join(root, "public-multiturn", "latest-passing.json"), "utf8")
      ).slug
    ).toBe(passingSlug);
  });

  it("keeps latest-passing on the prior run when a staged LoCoMo archive has no executable v0.3.11 gate", async () => {
    const passingSlug = "2026-05-14T080000Z-3aaaaaa";
    const stagedSlug = "2026-05-15T080000Z-3bbbbbb";
    const passing = KpiPayloadSchema.parse(buildLocomoPayload("3aaaaaa", 1982, 1982, 0.56));
    const staged = KpiPayloadSchema.parse(buildLocomoPayload("3bbbbbb", 100, 100, 0.99));

    await writeEntry(layout, "public-locomo", passingSlug, passing, "report", null);
    await writeEntry(layout, "public-locomo", stagedSlug, staged, "report", null);

    expect(collectReleaseHardGates(staged)).toEqual([]);
    expect(releaseHardGateAllowsLatestPassing(staged)).toBe(false);
    expect(renderFindings(staged, diffKpis(staged, null))).toBeNull();
    expect((await readLatest(layout, "public-locomo"))?.alaya_commit).toBe("3bbbbbb");
    expect((await readLatest(layout, "public-locomo", { pointerKind: "passing" }))?.alaya_commit)
      .toBe("3aaaaaa");
    expect(
      JSON.parse(await readFile(path.join(root, "public-locomo", "latest-run.json"), "utf8"))
        .slug
    ).toBe(stagedSlug);
    expect(
      JSON.parse(
        await readFile(path.join(root, "public-locomo", "latest-passing.json"), "utf8")
      ).slug
    ).toBe(passingSlug);
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
    // Latest-run pointer still references the first slug.
    const pointer = JSON.parse(
      await readFile(path.join(root, "self", "latest-run.json"), "utf8")
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
      readFile(path.join(root, "live", "latest-run.json"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(path.join(root, "live", slug, "kpi.json"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires live-gates sidecar proof before live archives advance latest-passing", async () => {
    const noGateSlug = "2026-05-15T140000Z-c0ffee1";
    const gatedSlug = "2026-05-15T150000Z-c0ffee2";

    await writeEntry(
      layout,
      "live",
      noGateSlug,
      buildLivePayload("c0ffee1"),
      "report\n",
      null
    );
    expect(
      JSON.parse(await readFile(path.join(root, "live", "latest-run.json"), "utf8")).slug
    ).toBe(noGateSlug);
    await expect(
      readFile(path.join(root, "live", "latest-passing.json"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });

    await writeEntry(
      layout,
      "live",
      gatedSlug,
      buildLivePayload("c0ffee2"),
      "report\n",
      null,
      {
        sidecars: [
          {
            filename: "live-gates.json",
            contents: JSON.stringify({
              latest_run_id: "run-1",
              status: "pass",
              gates: [{ id: "provider_top5", pass: true }]
            }) + "\n"
          }
        ]
      }
    );

    expect(
      JSON.parse(await readFile(path.join(root, "live", "latest-run.json"), "utf8")).slug
    ).toBe(gatedSlug);
    expect(
      JSON.parse(await readFile(path.join(root, "live", "latest-passing.json"), "utf8")).slug
    ).toBe(gatedSlug);
    expect((await readLatest(layout, "live", { pointerKind: "passing" }))?.alaya_commit)
      .toBe("c0ffee2");
  });

  // @anchor seed-extraction-release-blocker
  // Round-2 §B1: even when the live-gates sidecar passes, a degraded
  // seed_extraction_path (no_credentials_fallback or offline_fallbacks > 0)
  // must block live strict-real archives from latest-passing.
  it("blocks live strict-real latest-passing when seed_extraction_path is degraded (no_credentials_fallback)", async () => {
    const slug = "2026-05-15T160000Z-c0ffee3";
    const payload: KpiPayload = {
      ...buildLivePayload("c0ffee3"),
      kpi: {
        ...buildLivePayload("c0ffee3").kpi,
        seed_extraction_path: {
          path: "no_credentials_fallback",
          cache_hits: 0,
          llm_calls: 0,
          offline_fallbacks: 0,
          live_extraction_failures: 0,
          cached_extraction_failures: 0,
          facts_produced: 100,
          signals_dropped: 0,
          parse_dropped: 0,
          compile_overflow_dropped: 0
        }
      }
    };

    await writeEntry(layout, "live", slug, payload, "report\n", null, {
      sidecars: [
        {
          filename: "live-gates.json",
          contents: JSON.stringify({
            latest_run_id: "run-1",
            status: "pass",
            gates: [{ id: "provider_top5", pass: true }]
          }) + "\n"
        }
      ]
    });

    expect(
      JSON.parse(await readFile(path.join(root, "live", "latest-run.json"), "utf8")).slug
    ).toBe(slug);
    await expect(
      readFile(path.join(root, "live", "latest-passing.json"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readLatest(layout, "live", { pointerKind: "passing" })).toBeNull();
  });

  it("blocks live strict-real latest-passing when seed_extraction_path has offline_fallbacks", async () => {
    const slug = "2026-05-15T170000Z-c0ffee4";
    const payload: KpiPayload = {
      ...buildLivePayload("c0ffee4"),
      kpi: {
        ...buildLivePayload("c0ffee4").kpi,
        seed_extraction_path: {
          path: "official_api_compile",
          cache_hits: 10,
          llm_calls: 5,
          offline_fallbacks: 3,
          live_extraction_failures: 0,
          cached_extraction_failures: 0,
          facts_produced: 100,
          signals_dropped: 0,
          parse_dropped: 0,
          compile_overflow_dropped: 0
        }
      }
    };

    await writeEntry(layout, "live", slug, payload, "report\n", null, {
      sidecars: [
        {
          filename: "live-gates.json",
          contents: JSON.stringify({
            latest_run_id: "run-1",
            status: "pass",
            gates: [{ id: "provider_top5", pass: true }]
          }) + "\n"
        }
      ]
    });

    expect(
      JSON.parse(await readFile(path.join(root, "live", "latest-run.json"), "utf8")).slug
    ).toBe(slug);
    await expect(
      readFile(path.join(root, "live", "latest-passing.json"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readLatest(layout, "live", { pointerKind: "passing" })).toBeNull();
  });

  it("allows mixed live-gates sidecars with status pass and at least one passing source gate", async () => {
    const mixedSlug = "2026-05-15T160000Z-c0ffee3";

    await writeEntry(
      layout,
      "live",
      mixedSlug,
      buildLivePayload("c0ffee3"),
      "report\n",
      null,
      {
        sidecars: [
          {
            filename: "live-gates.json",
            contents: JSON.stringify({
              latest_run_id: "run-1",
              status: "pass",
              gates: [
                { id: "provider_top5", pass: true },
                { id: "optional_latency_budget", pass: false }
              ]
            }) + "\n"
          }
        ]
      }
    );

    expect(
      JSON.parse(await readFile(path.join(root, "live", "latest-passing.json"), "utf8")).slug
    ).toBe(mixedSlug);
    expect((await readLatest(layout, "live", { pointerKind: "passing" }))?.alaya_commit)
      .toBe("c0ffee3");
  });

  it("rejects live-gates sidecars with status pass but zero passing source gates", async () => {
    const blockedSlug = "2026-05-15T170000Z-c0ffee4";

    await writeEntry(
      layout,
      "live",
      blockedSlug,
      buildLivePayload("c0ffee4"),
      "report\n",
      null,
      {
        sidecars: [
          {
            filename: "live-gates.json",
            contents: JSON.stringify({
              latest_run_id: "run-1",
              status: "pass",
              gates: [
                { id: "provider_top5", pass: false },
                { id: "optional_latency_budget", pass: false }
              ]
            }) + "\n"
          }
        ]
      }
    );

    await expect(
      readFile(path.join(root, "live", "latest-passing.json"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readLatest(layout, "live", { pointerKind: "passing" })).toBeNull();
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

  it("readLatest can filter same-split archives by embedding provider", async () => {
    const basePayload: KpiPayload = {
      ...buildPayload("abc1234"),
      bench_name: "public",
      split: "longmemeval-s",
      policy_shape: "chat",
      simulate_report: "none",
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
      "2026-05-14T100000Z-abc1234-policy-chat",
      { ...basePayload, embedding_provider: "none" },
      "embedding off report",
      null
    );
    await writeEntry(
      layout,
      "public",
      "2026-05-14T110000Z-def5678-policy-chat",
      {
        ...basePayload,
        alaya_commit: "def5678",
        embedding_provider: "yunwu:text-embedding-3-small"
      },
      "embedding on report",
      null
    );

    const latestOff = await readLatest(layout, "public", {
      split: "longmemeval-s",
      policyShape: "chat",
      simulateReport: "none",
      embeddingProvider: "none"
    });
    const latestOn = await readLatest(layout, "public", {
      split: "longmemeval-s",
      policyShape: "chat",
      simulateReport: "none",
      embeddingProvider: "yunwu:text-embedding-3-small"
    });

    expect(latestOff?.embedding_provider).toBe("none");
    expect(latestOff?.alaya_commit).toBe("abc1234");
    expect(latestOn?.embedding_provider).toBe("yunwu:text-embedding-3-small");
    expect(latestOn?.alaya_commit).toBe("def5678");
    expect(
      JSON.parse(await readFile(path.join(root, "public", "latest-run-embedding-off.json"), "utf8")).slug
    ).toBe("2026-05-14T100000Z-abc1234-policy-chat");
    expect(
      JSON.parse(await readFile(path.join(root, "public", "latest-run-embedding-on.json"), "utf8")).slug
    ).toBe("2026-05-14T110000Z-def5678-policy-chat");
  });

  it("keeps filtered latest-passing separate from a failed latest-run and advances on the next pass", async () => {
    const passingSlug = "2026-05-14T100000Z-aaa1111-policy-chat";
    const failingSlug = "2026-05-14T110000Z-bbb2222-policy-chat";
    const nextPassingSlug = "2026-05-14T120000Z-ccc3333-policy-chat";
    const basePayload: KpiPayload = {
      ...buildPayload("aaa1111"),
      bench_name: "public",
      split: "longmemeval-s",
      embedding_provider: "none",
      policy_shape: "chat",
      simulate_report: "none",
      sample_size: 500,
      evaluated_count: 500,
      dataset: {
        name: "longmemeval_s",
        size: 500,
        source: "fixture"
      },
      kpi: {
        ...buildPayload("aaa1111").kpi,
        r_at_5: 0.91,
        latency_ms_p95: 110,
        quality_metrics: passingQualityMetrics(),
        seed_extraction_path: cleanSeedExtractionPath()
      }
    };

    await writeEntry(layout, "public", passingSlug, basePayload, "report", null);
    await writeEntry(
      layout,
      "public",
      failingSlug,
      {
        ...basePayload,
        alaya_commit: "bbb2222",
        run_at: "2026-05-14T11:00:00.000Z"
      },
      "report",
      "# findings\n- regression\n"
    );

    expect(
      (await readLatest(layout, "public", {
        split: "longmemeval-s",
        policyShape: "chat",
        simulateReport: "none",
        embeddingProvider: "none"
      }))?.alaya_commit
    ).toBe("bbb2222");
    expect(
      (await readLatest(layout, "public", {
        split: "longmemeval-s",
        policyShape: "chat",
        simulateReport: "none",
        embeddingProvider: "none",
        pointerKind: "passing"
      }))?.alaya_commit
    ).toBe("aaa1111");

    await writeEntry(
      layout,
      "public",
      nextPassingSlug,
      {
        ...basePayload,
        alaya_commit: "ccc3333",
        run_at: "2026-05-14T12:00:00.000Z"
      },
      "report",
      null
    );

    expect(
      (await readLatest(layout, "public", {
        split: "longmemeval-s",
        policyShape: "chat",
        simulateReport: "none",
        embeddingProvider: "none",
        pointerKind: "passing"
      }))?.alaya_commit
    ).toBe("ccc3333");
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

  it("flags LongMemEval-S 100 embedding-off reports below the release gate", () => {
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
        r_at_5: 0.68,
        latency_ms_p95: 110,
        quality_metrics: passingQualityMetrics()
      }
    };
    const parsedPayload = KpiPayloadSchema.parse(payload);
    const diff = diffKpis(parsedPayload, {
      ...payload,
      alaya_commit: "c0ffee0"
    });

    const report = renderReport(parsedPayload, parsedPayload, diff);
    expect(report).toContain("Worst verdict: **FAIL**");
    expect(report).toContain("Release hard gates");
    expect(report).toContain(
      "longmemeval_s_100_embedding_off_r_at_5 LongMemEval-S 100 embedding-off R@5"
    );
    expect(report).toContain("68.00% < target 70.00%");
    expect(report).toContain("candidate_absent: 0 <= target 6");
    expect(report).toContain("recall p95 embedding-off: 110ms <= target 200ms");

    const findings = renderFindings(parsedPayload, diff);
    expect(findings).toContain("Release hard gate gaps");
    expect(findings).toContain("current 68.00% < target 70.00%");
  });

  it("renders per-recall token economy in bench reports", () => {
    const payload = KpiPayloadSchema.parse({
      ...buildPayload("beef123"),
      kpi: {
        ...buildPayload("beef123").kpi,
        recall_token_economy: {
          schema_version: "bench-recall-token-economy.v1",
          sample_count: 3,
          delivered_context_tokens_estimate: perCallStat(42),
          coarse_pool_size: perCallStat(12),
          fine_evaluated: perCallStat(12),
          fusion_streams_with_hits: perCallStat(4),
          embedding_inference_calls: perCallStat(0.333)
        }
      }
    });

    const report = renderReport(payload, null, diffKpis(payload, null));

    expect(report).toContain("Per-recall token economy (3 calls, measure-only)");
    expect(report).toContain("delivered_context_tokens");
    expect(report).toContain("embedding_inference_calls");
  });

  it("defaults legacy seed extraction failure counters and renders new failure attribution", () => {
    const legacyPayload = KpiPayloadSchema.parse({
      ...buildPayload("beef123"),
      bench_name: "public",
      split: "longmemeval-s",
      kpi: {
        ...buildPayload("beef123").kpi,
        seed_extraction_path: {
          path: "official_api_compile",
          cache_hits: 276,
          llm_calls: 0,
          offline_fallbacks: 1,
          facts_produced: 1872,
          signals_dropped: 4,
          parse_dropped: 3,
          compile_overflow_dropped: 0
        }
      }
    });
    const legacySeedExtractionPath = legacyPayload.kpi.seed_extraction_path;
    expect(legacySeedExtractionPath).toMatchObject({
      live_extraction_failures: 0,
      cached_extraction_failures: 0
    });
    if (legacySeedExtractionPath === undefined) {
      throw new Error("expected seed_extraction_path");
    }

    const attributedPayload = KpiPayloadSchema.parse({
      ...legacyPayload,
      kpi: {
        ...legacyPayload.kpi,
        seed_extraction_path: {
          ...legacySeedExtractionPath,
          live_extraction_failures: 1,
          cached_extraction_failures: 2
        }
      }
    });
    const report = renderReport(
      attributedPayload,
      null,
      diffKpis(attributedPayload, null)
    );

    expect(report).toContain("live_failures=1 cached_failures=2");
    expect(report).toContain(
      "3 turn(s) fell back after official extraction failed"
    );
    expect(report).toContain("1 live/cache-miss failure(s)");
    expect(report).toContain("2 cached raw JSON failure(s)");
  });

  it("flags LongMemEval-S embedding full reports below the release gate", () => {
    const payload: KpiPayload = {
      ...buildPayload("beef123"),
      bench_name: "public",
      split: "longmemeval-s",
      embedding_provider: "none",
      sample_size: 500,
      evaluated_count: 500,
      dataset: {
        name: "longmemeval_s",
        size: 500,
        source: "fixture"
      },
      kpi: {
        ...buildPayload("beef123").kpi,
        r_at_5: 0.49,
        latency_ms_p95: 900,
        quality_metrics: passingQualityMetrics()
      }
    };
    const parsedPayload = KpiPayloadSchema.parse(payload);
    const diff = diffKpis(parsedPayload, {
      ...payload,
      alaya_commit: "c0ffee0"
    });

    const report = renderReport(parsedPayload, parsedPayload, diff);
    expect(report).toContain(
      "longmemeval_s_500_embedding_off_r_at_5 LongMemEval-S 500 embedding-off R@5"
    );
    expect(report).toContain("49.00% < target 90.00%");
  });

  it("fails embedding-on release gates when the provider never returns", () => {
    const payload: KpiPayload = {
      ...buildPayload("beef123"),
      bench_name: "public",
      split: "longmemeval-s",
      embedding_provider: "yunwu:text-embedding-3-small",
      sample_size: 100,
      evaluated_count: 100,
      dataset: {
        name: "longmemeval_s",
        size: 500,
        source: "fixture"
      },
      kpi: {
        ...buildPayload("beef123").kpi,
        r_at_5: 0.72,
        latency_ms_p95: 900,
        provider_returned_rate: 0,
        provider_pending_rate: 0,
        provider_failed_rate: 0,
        quality_metrics: passingQualityMetrics()
      }
    };
    const parsedPayload = KpiPayloadSchema.parse(payload);
    const gates = collectReleaseHardGates(parsedPayload);

    expect(gates).toContainEqual(
      expect.objectContaining({
        id: "embedding_provider_returned_rate",
        current: 0,
        target: 0.95,
        passed: false
      })
    );
    expect(renderReport(parsedPayload, parsedPayload, diffKpis(parsedPayload, null))).toContain(
      "embedding_provider_returned_rate embedding provider returned"
    );
  });

  it("flags LoCoMo embedding full reports below the release gate", () => {
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
        r_at_5: 0.39,
        latency_ms_p95: 900,
        quality_metrics: passingQualityMetrics()
      }
    };
    const parsedPayload = KpiPayloadSchema.parse(payload);
    const diff = diffKpis(parsedPayload, {
      ...payload,
      alaya_commit: "c0ffee0"
    });

    const report = renderReport(parsedPayload, parsedPayload, diff);
    expect(report).toContain(
      "locomo_full_embedding_on_r_at_5 LoCoMo full embedding-on R@5"
    );
    expect(report).toContain("39.00% < target 90.00%");
  });
});
