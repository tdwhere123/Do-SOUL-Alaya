import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  computeOfficialApiSourceCorpusIdentity, parseOfficialApiExtractionRequest,
  receiveOfficialApiSourceInterpretations, stringifyOfficialApiExtractionRequest
} from "@do-soul/alaya-soul";
import { readRetainedBatchRun } from "../fill/batch/store.js";
import { parseOutputInventory } from "../fill/batch/output-inventory.js";
import { decodeGeminiGenerateContent } from "../fill/batch/native-codec.js";
import { loadFrozenEnrichmentPopulation, type FrozenAssertion } from "./frozen-population.js";
import type { FrozenAssertionBinding, FrozenPopulationBindings } from "./source-binding.js";
import type { EnrichmentPreflight } from "./current-preflight.js";
import { nativeOutcomesFromInterpretationReceive } from "./interpretation-admission-outcomes.js";
import { composeEnrichmentPreparationReport } from "./preparation-report.js";
import { computeCacheKey } from "../../compile-seed/cache/cache-key.js";

/** Historical inputs remain immutable; this only derives current-code diagnostics. */
export function replayRetainedAdmission(input: {
  readonly cacheRoot: string;
  readonly planIdentity: string;
  readonly requestKey: string;
  readonly sourcePath: string;
  readonly preparationDirectory: string;
  readonly regressionPath: string;
  readonly canonicalPath: string;
}) {
  const retained = readRetainedBatchRun(input.cacheRoot, input.planIdentity);
  const line = retained.plan.lines.find((item) => item.key === input.requestKey);
  const job = retained.state.jobs.find((item) => item.lineKeys.includes(input.requestKey));
  if (line === undefined || job === undefined) throw new Error("selected request absent from retained Batch");
  const output = retained.outputs.get(job.id);
  if (output === undefined) throw new Error("retained Batch output missing");
  const result = decodeGeminiGenerateContent(parseOutputInventory(output, job).get(line.key)?.response);
  const request = parseOfficialApiExtractionRequest(JSON.parse(line.userPrompt));
  if (computeCacheKey(retained.plan.model, retained.plan.requestProfile, line.systemPrompt,
    stringifyOfficialApiExtractionRequest(request)) !== line.key) throw new Error("retained request key is not canonical");
  const sourceCorpus = readFileSync(input.sourcePath, "utf8");
  if (computeOfficialApiSourceCorpusIdentity(sourceCorpus) !== request.source_corpus_identity) {
    throw new Error("retained source corpus does not identify the selected request");
  }
  const population = loadFrozenEnrichmentPopulation(input);
  const sourceMap = JSON.parse(readFileSync(join(input.preparationDirectory, "source-map.json"), "utf8")) as {
    readonly candidate: string; readonly code_tree: string;
    readonly packing: FrozenPopulationBindings["packing"];
    readonly bindings: readonly (FrozenAssertion & Omit<FrozenAssertionBinding, "row">)[];
  };
  const preflight = JSON.parse(readFileSync(join(input.preparationDirectory, "preflight.json"), "utf8")) as EnrichmentPreflight;
  if (sourceMap.bindings.length !== population.rows.length) throw new Error("frozen source map denominator mismatch");
  const bindings: FrozenPopulationBindings = {
    packing: sourceMap.packing,
    bindings: population.rows.map((row) => {
      const matches = sourceMap.bindings.filter((binding) =>
        JSON.stringify(binding.annotation_pointer) === JSON.stringify(row.annotation_pointer));
      if (matches.length !== 1) throw new Error("frozen source map membership mismatch");
      const bound = matches[0]!;
      return { row, status: bound.status, reason: bound.reason, current: bound.current, occurrences: bound.occurrences };
    })
  };
  const selected = bindings.bindings.filter((binding) => binding.row.first_stage_subset);
  const attributions = selected.flatMap((binding) => binding.current.map((current) => {
    const member = request.source_assertions.find((item) => item.assertion_id === current.assertion_id);
    if (!current.request_keys?.includes(line.key) || current.sourceCorpusIdentity !== request.source_corpus_identity ||
      member === undefined || sourceCorpus.slice(current.locator.start, current.locator.end) !== member.text ||
      current.occurrenceIdentity === null) throw new Error("frozen selected occurrence does not bind retained request/source");
    return { annotation_pointer: binding.row.annotation_pointer, current_assertion_id: current.assertion_id,
      occurrence_identity: current.occurrenceIdentity };
  }));
  const receive = receiveOfficialApiSourceInterpretations(result.rawJson, request, {
    sourceCorpus, artifactKey: "retained-batch"
  });
  const nativeOutcomes = nativeOutcomesFromInterpretationReceive({ requestKey: line.key, receive, attributions });
  const report = composeEnrichmentPreparationReport({ population, bindings, preflight,
    selectedStage: "first_stage", nativeOutcomes,
    fixtureOutcomes: [{ name: "retained actual-model public consumption", kind: "public_consumption",
      result: "not_run", cell_state: "not_exercised", detail: "No publication or consumption during diagnostic replay." }]
  });
  return { report, receive, request, sourceCorpus, rawJson: result.rawJson,
    input_identity: { preparation_candidate: sourceMap.candidate, preparation_tree: sourceMap.code_tree,
      plan_identity: retained.plan.identity, request_key: line.key, job_id: job.id,
      raw_output_sha256: job.rawOutputSha256, historical_outcome: job.outcomes[line.key] ?? null },
    provider_calls: 0, query_calls: 0 };
}
