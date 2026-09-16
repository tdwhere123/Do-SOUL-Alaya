import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AlayaError, type ExtractionSourcePacking } from "@do-soul/alaya-protocol";
import type { LongMemEvalExtractionTurn } from "../turn-contents.js";
import { loadFrozenEnrichmentPopulation } from "./frozen-population.js";
import {
  runCurrentEnrichmentPreflight,
  type EnrichmentPreflight,
  type EnrichmentSemanticFillCapture
} from "./current-preflight.js";
import {
  bindFrozenPopulation,
  type FrozenAssertionBinding,
  type FrozenBindingRequest,
  type FrozenPopulationBindings
} from "./source-binding.js";
import { composeEnrichmentPreparationReport } from "./preparation-report.js";

export const ENRICHMENT_PREPARATION_CANDIDATE_PLACEHOLDER = "HEAD";
export function enrichmentPreparationIdentityNote(
  candidate: string,
  codeTree: string
): string {
  return `Candidate ${candidate} tree ${codeTree}`;
}

export interface EnrichmentPreparationEmitInput {
  readonly regressionPath: string;
  readonly canonicalPath: string;
  readonly outputDir: string;
  readonly cacheRoot: string;
  readonly dataDir?: string;
  readonly pinnedMetaRoot?: string;
  readonly turns?: readonly LongMemEvalExtractionTurn[];
  readonly datasetRevision?: string;
  readonly sourcePacking?: ExtractionSourcePacking;
  readonly candidate?: string;
  readonly codeTree?: string;
}

export interface EnrichmentPreparationEmitResult {
  readonly sourceMapPath: string;
  readonly preflightPath: string;
  readonly reportPath: string;
  readonly candidate: string;
  readonly code_tree: string;
  readonly attempted_fetches: number;
  readonly provider_calls: 0;
  readonly query_calls: 0;
  readonly semantic_fill: EnrichmentSemanticFillCapture;
  readonly source_fidelity: {
    readonly denominator: number;
    readonly bound: number;
    readonly unbound: number;
    readonly ineligible: number;
    readonly ambiguous: number;
    readonly partial: number;
    readonly dropped_rows: number;
  };
}

export async function emitEnrichmentPreparation(
  input: EnrichmentPreparationEmitInput
): Promise<EnrichmentPreparationEmitResult> {
  requireExistingFile(input.regressionPath, "regressionPath");
  requireExistingFile(input.canonicalPath, "canonicalPath");
  if (input.turns === undefined) {
    if (input.dataDir === undefined) {
      throw new AlayaError("VALIDATION", "enrichment preparation dataDir is required when turns are not supplied");
    }
    if (input.pinnedMetaRoot === undefined) {
      throw new AlayaError("VALIDATION", "enrichment preparation pinnedMetaRoot is required when turns are not supplied");
    }
  }
  mkdirSync(input.outputDir, { recursive: true });
  assertPreparationOutputWritable(input.outputDir);
  mkdirSync(input.cacheRoot, { recursive: true });
  const previousFetch = globalThis.fetch;
  let attemptedFetches = 0;
  globalThis.fetch = async () => {
    attemptedFetches += 1;
    throw new AlayaError("CONFLICT", "provider forbidden in enrichment preparation emit");
  };
  try {
    const population = loadFrozenEnrichmentPopulation({
      regressionPath: input.regressionPath,
      canonicalPath: input.canonicalPath
    });
    const preflight = await runCurrentEnrichmentPreflight({
      cacheRoot: input.cacheRoot,
      frozenRows: population.rows,
      ...(input.sourcePacking === undefined ? {} : { sourcePacking: input.sourcePacking }),
      ...(input.dataDir === undefined ? {} : { dataDir: input.dataDir }),
      ...(input.pinnedMetaRoot === undefined ? {} : { pinnedMetaRoot: input.pinnedMetaRoot }),
      ...(input.turns === undefined ? {} : { turns: input.turns }),
      ...(input.datasetRevision === undefined ? {} : { datasetRevision: input.datasetRevision })
    });
    if (preflight.attempted_fetches !== 0 || attemptedFetches !== 0) {
      throw new AlayaError("CONFLICT", "enrichment preparation emit attempted a provider fetch");
    }
    const bindings = bindFrozenPopulation(population.rows, {
      catalogUnits: preflight.units,
      requests: toBindingRequests(preflight),
      packs: preflight.packs
    });
    const report = composeEnrichmentPreparationReport({
      population,
      bindings,
      preflight,
      selectedStage: "none"
    });
    const candidate = input.candidate ?? ENRICHMENT_PREPARATION_CANDIDATE_PLACEHOLDER;
    const codeTree = input.codeTree ?? ENRICHMENT_PREPARATION_CANDIDATE_PLACEHOLDER;
    const sourceMapPath = resolve(input.outputDir, "source-map.json");
    const preflightPath = resolve(input.outputDir, "preflight.json");
    const reportPath = resolve(input.outputDir, "preparation-report.json");
    writeJson(sourceMapPath, serializeSourceMap({
      candidate,
      codeTree,
      populationCounts: population.counts,
      bindings,
      preflight,
      fidelity: report.source_fidelity
    }));
    writeJson(preflightPath, serializePreflightDocument({
      candidate,
      codeTree,
      bindings,
      preflight
    }));
    writeJson(reportPath, report);
    return Object.freeze({
      sourceMapPath,
      preflightPath,
      reportPath,
      candidate,
      code_tree: codeTree,
      attempted_fetches: 0,
      provider_calls: 0,
      query_calls: 0,
      semantic_fill: preflight.semantic_fill,
      source_fidelity: Object.freeze({
        denominator: report.source_fidelity.denominator,
        bound: report.source_fidelity.bound,
        unbound: report.source_fidelity.unbound,
        ineligible: report.source_fidelity.ineligible,
        ambiguous: report.source_fidelity.ambiguous,
        partial: report.source_fidelity.partial,
        dropped_rows: report.source_fidelity.dropped_rows
      })
    });
  } finally {
    globalThis.fetch = previousFetch;
  }
}

export function toBindingRequests(
  preflight: Pick<EnrichmentPreflight, "requests">
): readonly FrozenBindingRequest[] {
  return Object.freeze(preflight.requests.map((request) => Object.freeze({
    key: request.key,
    source_corpus_identity: request.source_corpus_identity,
    message_ids: request.message_ids,
    source_assertions: Object.freeze(request.occurrence_provenance.map((occurrence) => ({
      ...occurrence,
      text: request.assertion_texts[request.assertion_ids.indexOf(occurrence.assertion_id)] ?? ""
    })))
  })));
}

function serializeSourceMap(input: {
  readonly candidate: string;
  readonly codeTree: string;
  readonly populationCounts: {
    readonly total: number;
    readonly required: number;
    readonly optional: number;
    readonly unresolved: number;
  };
  readonly bindings: FrozenPopulationBindings;
  readonly preflight: EnrichmentPreflight;
  readonly fidelity: {
    readonly required_group_ids: {
      readonly first_stage: readonly string[];
      readonly full: readonly string[];
    };
    readonly bound: number;
    readonly unbound: number;
    readonly ineligible: number;
    readonly ambiguous: number;
    readonly partial: number;
    readonly dropped_rows: number;
  };
}): unknown {
  return {
    candidate: input.candidate,
    code_tree: input.codeTree,
    identity_note: enrichmentPreparationIdentityNote(input.candidate, input.codeTree),
    provider_calls: 0,
    query_calls: 0,
    attempted_fetches: input.preflight.attempted_fetches,
    catalog_status: "loaded",
    catalog_unresolved_reason: null,
    population_counts: input.populationCounts,
    first_stage_assertion_ids: firstStageAssertionIds(input.bindings),
    required_group_ids: input.fidelity.required_group_ids,
    packing: serializePacking(input.bindings, input.preflight),
    bound: input.fidelity.bound,
    unbound: input.fidelity.unbound,
    ineligible: input.fidelity.ineligible,
    ambiguous: input.fidelity.ambiguous,
    partial: input.fidelity.partial,
    dropped_rows: input.fidelity.dropped_rows,
    bindings: input.bindings.bindings.map(serializeBindingRow)
  };
}

function serializePreflightDocument(input: {
  readonly candidate: string;
  readonly codeTree: string;
  readonly bindings: FrozenPopulationBindings;
  readonly preflight: EnrichmentPreflight;
}): unknown {
  const firstStageKeys = firstStageRequestKeys(input.bindings);
  const firstStageLines = input.preflight.bounds.lines.filter((line) => firstStageKeys.includes(line.key));
  const sized = input.preflight.bounds.lines.filter((line) => line.status === "sized");
  const unresolved = input.preflight.bounds.lines.filter((line) => line.status === "unresolved");
  return {
    candidate: input.candidate,
    code_tree: input.codeTree,
    identity_note: enrichmentPreparationIdentityNote(input.candidate, input.codeTree),
    status: input.preflight.bounds.unresolved_native_bound ? "unresolved" : "sized",
    reason: null,
    identities: input.preflight.identities,
    annotation_interpolation: input.preflight.annotation_interpolation,
    attempted_fetches: input.preflight.attempted_fetches,
    provider_calls: 0,
    query_calls: 0,
    dispatch_authorized: false,
    nonempty_request_count: input.preflight.nonempty_request_count,
    deterministic_empty_request_count: input.preflight.deterministic_empty_request_count,
    cached_request_count: input.preflight.cached_request_count,
    unique_request_count: input.preflight.requests.length,
    unit_count: input.preflight.units.length,
    pack_count: input.preflight.packs.length,
    pack_cardinality_histogram: histogram(input.preflight.packs.map((pack) => pack.assertion_ids.length)),
    request_assertion_cardinality_histogram: histogram(
      input.preflight.requests.map((request) => request.assertion_ids.length)
    ),
    first_stage_request_keys: firstStageKeys,
    first_stage_line_bounds: firstStageLines,
    first_stage_binding_statuses: countFirstStageStatuses(input.bindings),
    semantic_fill: input.preflight.semantic_fill,
    native_fill_readiness: input.preflight.semantic_fill.status,
    preparation_stops: {
      kind: "preparation",
      provider_calls_must_be_zero: true,
      query_calls_must_be_zero: true,
      dispatch_authorized: false,
      human_unreviewed_does_not_block_first_window_proposal: true
    },
    future_execution_stops: {
      kind: "future_paid_execution",
      owned_by: "a later paid card; not opened by preparation",
      dispatch: true,
      spend_reservation: true,
      post_response_semantic_acceptance: true
    },
    bounds: {
      max_output_tokens: input.preflight.bounds.max_output_tokens,
      dispatch_authorized: false,
      unresolved_native_bound: input.preflight.bounds.unresolved_native_bound,
      sized_line_count: sized.length,
      unresolved_line_count: unresolved.length,
      unresolved_reasons: unresolved.flatMap((line) => line.reason === undefined ? [] : [line.reason]),
      max_input_bound: maxNumber(sized.map((line) => line.input_bound)),
      max_file_bytes: maxNumber(sized.map((line) => line.file_bytes)),
      max_cost_bound_usd: maxNumber(sized.map((line) => line.cost_bound_usd)),
      sum_cost_bound_usd: sumNumber(sized.map((line) => line.cost_bound_usd)),
      prices_refreshed: false,
      note: "Recorded 2026-09-12 Batch 0.125/0.75 USD per million tokens are unrefreshed dated inputs, not a fresh provider check."
    },
    request_membership_omitted: "full user_prompt/request bodies omitted; identities, counts, packing and bound extrema are retained"
  };
}

function serializeBindingRow(binding: FrozenAssertionBinding): unknown {
  const row = binding.row;
  return {
    annotation_pointer: row.annotation_pointer,
    population: row.population,
    original_ordinal: row.original_ordinal,
    exact_text: row.exact_text,
    original_source: row.original_source,
    occurrence: row.occurrence,
    classification: row.classification,
    required_group_id: row.required_group_id,
    first_stage_subset: row.first_stage_subset,
    duplicate_of: row.duplicate_of,
    obligations: row.obligations,
    forbidden: row.forbidden,
    participants: row.participants,
    source_role: row.source_role,
    modality: row.modality,
    conditions: row.conditions,
    scope: row.scope,
    time: row.time,
    event_policy: row.event_policy,
    status: binding.status,
    reason: binding.reason,
    current: binding.current,
    occurrences: binding.occurrences
  };
}

function serializePacking(bindings: FrozenPopulationBindings, preflight: EnrichmentPreflight): unknown {
  return {
    request_count: bindings.packing.request_count,
    pack_count: bindings.packing.pack_count,
    unit_count: bindings.packing.unit_count,
    pack_cardinality_histogram: histogram(preflight.packs.map((pack) => pack.assertion_ids.length)),
    request_assertion_cardinality_histogram: histogram(
      preflight.requests.map((request) => request.assertion_ids.length)
    )
  };
}

function firstStageAssertionIds(bindings: FrozenPopulationBindings): readonly number[] {
  return Object.freeze(
    bindings.bindings
      .filter((item) => item.row.first_stage_subset)
      .map((item) => item.row.annotation_pointer.assertion_id)
  );
}

function firstStageRequestKeys(bindings: FrozenPopulationBindings): readonly string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const binding of bindings.bindings) {
    if (!binding.row.first_stage_subset) continue;
    for (const current of binding.current) {
      if (current.request_keys === null) continue;
      for (const key of current.request_keys) {
        if (seen.has(key)) continue;
        seen.add(key);
        keys.push(key);
      }
    }
  }
  return Object.freeze(keys);
}

function countFirstStageStatuses(bindings: FrozenPopulationBindings): Record<string, number> {
  const counts = { bound: 0, unbound: 0, ineligible: 0, ambiguous: 0, partial: 0 };
  for (const binding of bindings.bindings) {
    if (!binding.row.first_stage_subset) continue;
    counts[binding.status] += 1;
  }
  return counts;
}

function histogram(values: readonly number[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    const key = String(value);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function maxNumber(values: readonly (number | undefined)[]): number | null {
  const present = values.filter((item): item is number => item !== undefined);
  return present.length === 0 ? null : present.reduce((max, item) => item > max ? item : max);
}

function sumNumber(values: readonly (number | undefined)[]): number | null {
  const present = values.filter((item): item is number => item !== undefined);
  return present.length === 0 ? null : present.reduce((sum, item) => sum + item, 0);
}

const PREPARATION_OUTPUT_FILES = [
  "source-map.json",
  "preflight.json",
  "preparation-report.json"
] as const;

function assertPreparationOutputWritable(outputDir: string): void {
  const existing = PREPARATION_OUTPUT_FILES.filter((name) => existsSync(resolve(outputDir, name)));
  if (existing.length === 0) return;
  if (existing.length === PREPARATION_OUTPUT_FILES.length) {
    throw new AlayaError(
      "CONFLICT",
      `enrichment preparation output already exists: ${PREPARATION_OUTPUT_FILES.join(", ")}`
    );
  }
  throw new AlayaError(
    "CONFLICT",
    `enrichment preparation output is incomplete and must not be overwritten: ${existing.join(", ")}`
  );
}

function requireExistingFile(path: string, label: string): void {
  if (!existsSync(path)) {
    throw new AlayaError("VALIDATION", `enrichment preparation ${label} is required and missing: ${path}`);
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

function readRequiredFlag(argv: readonly string[], name: string): string {
  const index = argv.indexOf(`--${name}`);
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (value === undefined || value.length === 0 || value.startsWith("--")) {
    throw new AlayaError("VALIDATION", `emit enrichment preparation requires --${name}`);
  }
  return value;
}

function readOptionalFlag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (value === undefined || value.length === 0 || value.startsWith("--")) return undefined;
  return value;
}

function isDirectInvocation(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return import.meta.url === pathToFileURL(resolve(entry)).href;
}

async function emitFromArgv(argv: readonly string[]): Promise<void> {
  const result = await emitEnrichmentPreparation({
    regressionPath: readRequiredFlag(argv, "regressionPath"),
    canonicalPath: readRequiredFlag(argv, "canonicalPath"),
    dataDir: readRequiredFlag(argv, "dataDir"),
    pinnedMetaRoot: readRequiredFlag(argv, "pinnedMetaRoot"),
    outputDir: readRequiredFlag(argv, "outputDir"),
    cacheRoot: readRequiredFlag(argv, "cacheRoot"),
    ...(readOptionalFlag(argv, "candidate") === undefined
      ? {}
      : { candidate: readOptionalFlag(argv, "candidate") }),
    ...(readOptionalFlag(argv, "codeTree") === undefined
      ? {}
      : { codeTree: readOptionalFlag(argv, "codeTree") })
  });
  process.stdout.write(`${JSON.stringify({
    sourceMapPath: result.sourceMapPath,
    preflightPath: result.preflightPath,
    reportPath: result.reportPath,
    attempted_fetches: result.attempted_fetches,
    provider_calls: result.provider_calls,
    query_calls: result.query_calls,
    semantic_fill: result.semantic_fill,
    source_fidelity: result.source_fidelity
  }, null, 2)}\n`);
}

if (isDirectInvocation()) {
  void emitFromArgv(process.argv.slice(2)).catch((cause: unknown) => {
    process.stderr.write(`${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}\n`);
    process.exitCode = 1;
  });
}
