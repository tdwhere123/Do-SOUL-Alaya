import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { expect, it } from "vitest";
import { replayRetainedAdmission } from "../../../../../../apps/bench-runner/src/runs/extraction/enrichment-acceptance/retained-admission-replay.js";
import { resultCandidateIdentity } from "./source-discovery-public-consumption-evidence.js";

const configuration = process.env.ALAYA_RETAINED_ADMISSION_CONFIG;

// Retained generation inspection is opt-in and never republishes its retired passive output.
it.skipIf(configuration === undefined)("inspects retained native evidence against frozen bindings without provider calls",  async () => {
  const input = JSON.parse(readFileSync(configuration!, "utf8")) as Parameters<typeof replayRetainedAdmission>[0];
  const directory = process.env.ALAYA_ADMISSION_EVIDENCE_DIRECTORY;
  if (directory === undefined) throw new Error("replay evidence directory is required");
  // The command creates this directory only after checking its canonical prospective path.
  const outputRelative = relative(dirname(realpathSync(input.cacheRoot)), realpathSync(directory));
  if (outputRelative === "" || (!isAbsolute(outputRelative) && outputRelative !== ".." && !outputRelative.startsWith(`..${sep}`))) {
    throw new Error("derived reports must stay outside the retained paid root");
  }
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => { fetches += 1; throw new Error("provider forbidden during retained replay"); };
  try {
    const derived = replayRetainedAdmission(input);
    const identity = resultCandidateIdentity();
    if (identity.result_sha === "unavailable") throw new Error("retained replay requires a clean committed candidate");
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `retained-admission-${identity.result_sha}-${Date.now()}.json`);
    writeFileSync(path, JSON.stringify({ result_identity: identity, ...derived,
      automatic_publication: { status: "retired", native_replay: false }, provider_calls: fetches }, null, 2) + "\n", { flag: "wx" });
    const reopened = JSON.parse(readFileSync(path, "utf8")) as typeof derived;
    expect(reopened.report.source_fidelity.rows).toHaveLength(38);
    expect(reopened.report.source_fidelity.rows.filter((row) => !row.selected)).toHaveLength(30);
    expect(reopened.report.source_fidelity.rows.filter((row) => !row.selected)
      .every((row) => row.raw_state === "not_exercised")).toBe(true);
    expect(reopened.report.native_formation_publication.unmatched_native_outcomes).toEqual([]);
    expect(reopened.report.source_fidelity.rows.filter((row) => row.selected)
      .flatMap((row) => row.native_cells).every((cell) =>
        cell.request_key === input.requestKey && cell.occurrence_identity !== undefined)).toBe(true);
    expect(fetches).toBe(0);
  } finally { globalThis.fetch = originalFetch; }
}, 120_000);
