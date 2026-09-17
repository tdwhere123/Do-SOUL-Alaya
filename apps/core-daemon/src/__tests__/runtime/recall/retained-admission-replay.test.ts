import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { expect, it } from "vitest";
import { DEFAULT_EXTRACTION_SOURCE_PACKING } from "@do-soul/alaya-protocol";
import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import { replayRetainedAdmission } from "../../../../../../apps/bench-runner/src/runs/extraction/enrichment-acceptance/retained-admission-replay.js";
import { readExtractionCacheManifest } from "../../../../../../apps/bench-runner/src/runs/extraction/cache/extraction-cache-manifest.js";
import { bindAdmittedActualModelShard } from "./source-discovery-admitted-public-publication.js";
import { runAdmittedPublicMatrix } from "./source-discovery-admitted-matrix.js";
import { resultCandidateIdentity } from "./source-discovery-public-consumption-evidence.js";

const configuration = process.env.ALAYA_RETAINED_ADMISSION_CONFIG;

// Explicit opt-in evidence replay is skipped by portable suites; the command requires all inputs.
it.skipIf(configuration === undefined)("replays retained native evidence against frozen bindings without provider calls", async () => {
  const input = JSON.parse(readFileSync(configuration!, "utf8")) as Parameters<typeof replayRetainedAdmission>[0];
  const directory = process.env.ALAYA_ADMISSION_EVIDENCE_DIRECTORY;
  if (directory === undefined) throw new Error("replay evidence directory is required");
  if (!relative(resolve(input.cacheRoot, ".."), resolve(directory)).startsWith("..")) {
    throw new Error("derived reports must stay outside the retained paid root");
  }
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => { fetches += 1; throw new Error("provider forbidden during retained replay"); };
  try {
    const derived = replayRetainedAdmission(input);
    const identity = resultCandidateIdentity();
    if (identity.result_sha === "unavailable") throw new Error("retained replay requires a clean committed candidate");
    const manifest = readExtractionCacheManifest(input.cacheRoot);
    if (manifest === undefined || manifest.schema_version < 3) throw new Error("retained generation manifest unavailable");
    const actual = bindAdmittedActualModelShard({ cacheRoot: input.cacheRoot,
      model: manifest.extraction_model, modelFamily: manifest.model_family,
      providerUrl: manifest.provider_url, requestProfile: manifest.request_profile!,
      sourcePacking: manifest.schema_version === 4 ? manifest.source_packing : DEFAULT_EXTRACTION_SOURCE_PACKING,
      systemPrompt: OFFICIAL_API_SYSTEM_PROMPT, sourceCorpus: derived.sourceCorpus,
      artifactKey: "retained-actual-model", request: derived.request, cacheKey: input.requestKey,
      retainedBatchPlanIdentity: input.planIdentity });
    const consumption = await runAdmittedPublicMatrix({ bind: actual, sourceCorpus: derived.sourceCorpus,
      evidenceDirectory: directory });
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `retained-admission-${identity.result_sha}-${Date.now()}.json`);
    writeFileSync(path, JSON.stringify({ result_identity: identity, ...derived,
      actual_model: { bind: actual, consumption }, provider_calls: fetches }, null, 2) + "\n", { flag: "wx" });
    const reopened = JSON.parse(readFileSync(path, "utf8")) as typeof derived;
    expect(reopened.report.source_fidelity.rows).toHaveLength(38);
    expect(reopened.report.source_fidelity.rows.filter((row) => !row.selected)).toHaveLength(30);
    expect(reopened.report.source_fidelity.rows.filter((row) => !row.selected)
      .every((row) => row.raw_state === "not_exercised")).toBe(true);
    expect(reopened.report.native_formation_publication.unmatched_native_outcomes).toEqual([]);
    expect(reopened.report.source_fidelity.rows.filter((row) => row.selected)
      .flatMap((row) => row.native_cells).every((cell) =>
        cell.request_key === input.requestKey && cell.occurrence_identity !== undefined)).toBe(true);
    if (derived.receive.status === "partial") {
      expect(actual.status).toBe("not_exercised");
      expect(consumption.completed).toEqual([]);
      expect(consumption.utility.accepted).toBe(false);
    }
    expect(fetches).toBe(0);
  } finally { globalThis.fetch = originalFetch; }
}, 120_000);
