import { describe, expect, it } from "vitest";
import type { KpiPayload } from "@do-soul/alaya-eval";
import {
  appendSeedExtractionReleaseBlockerToFindings,
  appendSeedExtractionReleaseBlockerToReport,
  hasSeedExtractionReleaseBlocker,
  seedExtractionReleaseBlockerExitCode
} from "../longmemeval/seed-extraction-release-blocker.js";

function makePayload(
  seedExtractionPath?: KpiPayload["kpi"]["seed_extraction_path"],
  benchName: KpiPayload["bench_name"] = "public"
): KpiPayload {
  return {
    bench_name: benchName,
    split: "longmemeval-s",
    kpi: {
      ...(seedExtractionPath === undefined
        ? {}
        : { seed_extraction_path: seedExtractionPath })
    }
  } as KpiPayload;
}

function makeSeedExtractionPath(
  input: Partial<NonNullable<KpiPayload["kpi"]["seed_extraction_path"]>> = {}
): NonNullable<KpiPayload["kpi"]["seed_extraction_path"]> {
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
    compile_overflow_dropped: 0,
    ...input
  };
}

describe("LongMemEval seed extraction release blocker", () => {
  it("blocks official extraction evidence when offline fallbacks are non-zero", () => {
    const payload = makePayload(
      makeSeedExtractionPath({
        offline_fallbacks: 1,
        live_extraction_failures: 1
      })
    );

    expect(hasSeedExtractionReleaseBlocker(payload)).toBe(true);
    expect(seedExtractionReleaseBlockerExitCode(payload)).toBe(1);
    expect(appendSeedExtractionReleaseBlockerToReport("report\n", payload))
      .toContain("seed_extraction_path offline_fallbacks");
    expect(appendSeedExtractionReleaseBlockerToFindings(null, payload))
      .toContain("offline_fallbacks=1");
    expect(appendSeedExtractionReleaseBlockerToFindings(null, payload))
      .toContain("live_failures=1");
  });

  it("blocks no-credential fallback evidence even when numeric gates pass", () => {
    const payload = makePayload(
      makeSeedExtractionPath({
        path: "no_credentials_fallback",
        cache_hits: 0,
        offline_fallbacks: 8
      })
    );

    expect(hasSeedExtractionReleaseBlocker(payload)).toBe(true);
    expect(seedExtractionReleaseBlockerExitCode(payload)).toBe(1);
    expect(appendSeedExtractionReleaseBlockerToFindings("# findings\n", payload))
      .toContain("seed_extraction_path no_credentials_fallback");
  });

  it("does not block clean official extraction payloads", () => {
    const cleanOfficial = makePayload(makeSeedExtractionPath());

    expect(hasSeedExtractionReleaseBlocker(cleanOfficial)).toBe(false);
    expect(seedExtractionReleaseBlockerExitCode(cleanOfficial)).toBe(0);
    expect(appendSeedExtractionReleaseBlockerToReport("report\n", cleanOfficial))
      .toBe("report\n");
    expect(appendSeedExtractionReleaseBlockerToFindings(null, cleanOfficial))
      .toBeNull();
  });

  it("blocks LongMemEval payloads with no seed_extraction_path provenance (defensive default)", () => {
    // Previously this case ("legacy no-provenance") was silently allowed.
    // Finding B0-1 closes the bypass: missing path on a LongMemEval bench is
    // now treated as degraded, because seeding integrity cannot be verified.
    const missingOnLongMemEval = makePayload();

    expect(hasSeedExtractionReleaseBlocker(missingOnLongMemEval)).toBe(true);
    expect(seedExtractionReleaseBlockerExitCode(missingOnLongMemEval)).toBe(1);
    expect(appendSeedExtractionReleaseBlockerToFindings(null, missingOnLongMemEval))
      .toContain("seed_extraction_path missing_on_longmemeval");
  });

  it("does not block non-LongMemEval payloads that pre-date the provenance field", () => {
    // LoCoMo and other non-LongMemEval benches may legitimately omit the
    // field today; back-compat is preserved until they emit it explicitly.
    const locomoMissing = makePayload(undefined, "public-locomo");

    expect(hasSeedExtractionReleaseBlocker(locomoMissing)).toBe(false);
    expect(seedExtractionReleaseBlockerExitCode(locomoMissing)).toBe(0);
  });
});
