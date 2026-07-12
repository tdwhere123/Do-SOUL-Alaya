import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { diffKpis } from "../../history/diff.js";
import {
  HistoryEntryCommittedError,
  listEntries,
  readLatest,
  reconcileHistoryEntryPointers,
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
  buildPayload} from "./history-fixture.js";

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

  it("does not advance latest-passing for legacy LongMemEval without measurement attribution", async () => {
    const slug = "2026-05-16T080000Z-0cccccc";
    const { measurement_attribution: _attribution, ...legacy } =
      buildFullLongMemEvalPayload("public", "0cccccc", 0.95);

    await writeEntry(layout, "public", slug, legacy as KpiPayload, "report", null);

    expect(JSON.parse(await readFile(path.join(root, "public", "latest-run.json"), "utf8")).slug)
      .toBe(slug);
    await expect(readFile(path.join(root, "public", "latest-passing.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
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
    const fullLimited = buildFullLongMemEvalPayload(
      "public-multiturn",
      "0bbbbbb",
      1
    );
    const limited = KpiPayloadSchema.parse({
      ...fullLimited,
      evaluated_count: 20,
      answerable_evaluated_count: 20,
      kpi: { ...fullLimited.kpi, per_scenario: fullLimited.kpi.per_scenario.slice(0, 20) }
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

  it("reports committed state when pointer publication fails after entry rename", async () => {
    const slug = "2026-05-15T133000Z-c0ffee0";
    const stagedEvidence = path.join(root, "staged-evidence.gz");
    await writeFile(stagedEvidence, "bound gzip evidence");
    const failure = writeEntry(
      layout, "live", slug, buildPayload("c0ffee0"), "report\n", null,
      {
        fileSidecars: [{
          filename: "longmemeval-diagnostics.json.gz",
          sourcePath: stagedEvidence
        }],
        pointerWriter: async () => { throw new Error("injected pointer failure"); }
      }
    );

    const error = await failure.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HistoryEntryCommittedError);
    await expect(readFile(path.join(root, "live", slug, "kpi.json"), "utf8"))
      .resolves.toContain('"alaya_commit": "c0ffee0"');
    await expect(readFile(
      path.join(root, "live", slug, "longmemeval-diagnostics.json.gz"), "utf8"
    )).resolves.toBe("bound gzip evidence");
    expect(await listEntries(layout, "live")).toEqual([slug]);
    await reconcileHistoryEntryPointers(
      layout,
      "live",
      (error as HistoryEntryCommittedError).entry,
      buildPayload("c0ffee0"),
      null
    );
    expect(JSON.parse(await readFile(
      path.join(root, "live", "latest-run.json"), "utf8"
    )).slug).toBe(slug);
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
  // invariant: even when the live-gates sidecar passes, a degraded
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
          compile_overflow_dropped: 0,
          signals_dropped_by_reason: { candidate_absent: 0, materialization_drop: 0 }
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
          compile_overflow_dropped: 0,
          signals_dropped_by_reason: { candidate_absent: 0, materialization_drop: 0 }
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

});
