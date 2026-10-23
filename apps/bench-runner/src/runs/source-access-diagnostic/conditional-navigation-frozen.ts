import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { AlayaError, canonicalJson, SourceSemanticProfiledAcquisitionPhaseSchema, SourceSemanticQueryPreparationSchema,
  SourceSemanticRetainedNominationWitnessSchema, sourceSemanticRetainedWitnessMatchesPhase,
  sourceIndexProfileId, sourceIndexConfigurationId, sourceIndexGenerationId, sourceIndexTarget, SourceIndexOperationError } from "@do-soul/alaya-protocol";
import { authorizeSemanticScope, fieldContractSha256 } from "@do-soul/alaya-core";
import { SqliteFieldSourceRecordRepo, type SqliteSourceIndexRepository, type StorageDatabase } from "@do-soul/alaya-storage";
import { readBoundedStableRegularFile, decodeCanonicalUtf8Artifact } from "../extraction/cache-audit/bounded-artifact-reader.js";
import { ConditionalNavigationRunSchema, type NavigationRun, type RunRow } from "./conditional-navigation-input.js";
import { NAVIGATION_CONTRACT, navigationInventory, solveConditionalNavigation } from "./conditional-navigation.js";
import { navigationReadAccounting, readNavigationSource, NAVIGATION_SOURCE_READ_ALLOWANCE } from "./navigation-read-budget.js";

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const Reference = z.object({ ordinal: z.number().int(), question_id: z.string().min(1), path: z.string().min(1), sha256: Sha256,
  arm: z.never().optional(), status: z.never().optional() }).passthrough();
const Receipt = z.object({ contract: z.literal(NAVIGATION_CONTRACT), source_revision: z.string().min(1),
  status: z.literal("complete"), failure: z.null(), input_sha256: Sha256, rows: z.array(Reference).min(1).max(8) }).passthrough();
export const FrozenQueryCaptureSchema = z.object({ condition: z.string().min(1), preparation: SourceSemanticQueryPreparationSchema,
  phase: SourceSemanticProfiledAcquisitionPhaseSchema, witness: SourceSemanticRetainedNominationWitnessSchema }).strict();
const Capture = z.object({ ordinal: z.number().int(), question_id: z.string().min(1), arm: z.never().optional(),
  interpretation_clock: z.string(), inventory: z.literal("admitted_nomination_union"),
  captures: z.array(FrozenQueryCaptureSchema).length(1), occurrences: z.unknown(), pool: z.unknown(),
  solved: z.object({ rows: z.array(z.object({ record_id: z.string() }).passthrough()) }).passthrough() }).passthrough();
export type FrozenQueries = z.infer<typeof FrozenQueryCaptureSchema>[];
export const FrozenNominationArtifactSchema = z.object({ family: z.literal("conditional-navigation-pilot.v1"),
  origin: z.object({ source_revision: z.string().min(1), receipt_sha256: Sha256, input_sha256: Sha256 }).strict(),
  rows: z.array(z.object({ ordinal: z.number().int(), question_id: z.string(), capture_sha256: Sha256,
    captures: z.array(FrozenQueryCaptureSchema).length(1), nomination: z.enum(["witnessed", "measured_empty", "unknown"]) }).strict()).min(1).max(8),
  inherited_costs: z.object({}).passthrough() }).strict();
function check(test: boolean, message: string): asserts test { if (!test) throw new AlayaError("VALIDATION", message); }

/** All bytes and caller configuration are captured synchronously, before the run's
 * first await. Only this named, pre-arm pilot format is adapted. Old previews and
 * solved values never supply delivery or ranking. Hashes attest origin, not currentness. */
export function admitFrozenNominations(config: NavigationRun) {
  const option = config.frozen_nominations;
  if (!option) return undefined;
  check(config.channels === "dual" && config.comparison === undefined && config.model_id === undefined,
    "frozen nominations do not support channel, formation or model overrides");
  const read = (path: string, sha256: string, maxBytes: number) => {
    const artifact = readBoundedStableRegularFile({ path, maxBytes, label: "frozen nomination artifact" });
    check(artifact.identity.sha256 === sha256, "frozen nomination artifact digest mismatch");
    return JSON.parse(decodeCanonicalUtf8Artifact(artifact.bytes, "frozen nomination artifact")) as unknown;
  };
  const receipt = Receipt.parse(read(option.receipt.path, option.receipt.sha256, 1024 * 1024));
  const home = dirname(option.receipt.path), inputPath = join(home, "input.json");
  const inherited = ConditionalNavigationRunSchema.parse(read(inputPath, receipt.input_sha256, 1024 * 1024));
  check(inherited.frozen_nominations === undefined && inherited.comparison === undefined && inherited.model_id === undefined
    && inherited.channels === config.channels && inherited.cache_root === config.cache_root
    && receipt.source_revision === inherited.source_revision, "frozen origin/input binding mismatch");
  check(canonicalJson(config.rows) === canonicalJson(inherited.rows) && receipt.rows.length === config.rows.length,
    "frozen input membership/configuration mismatch");
  check(new Set(receipt.rows.map(row => row.ordinal)).size === receipt.rows.length
    && new Set(receipt.rows.map(row => row.path)).size === receipt.rows.length, "ambiguous frozen receipt membership");
  const rows = config.rows.map(row => {
    check(row.conditions.length === 1 && row.conditions[0]?.id === row.original && row.conditions[0].status === "ready"
      && row.conditions[0].observation_window === undefined && row.branches.length === 0 && row.expected_index !== null
      && row.delivery_policy === undefined && row.structural_navigation === undefined && row.observation_domain === undefined,
    "frozen nominations support only original-query field-order delivery without navigation interventions");
    const matches = receipt.rows.filter(ref => ref.ordinal === row.ordinal && ref.question_id === row.question_id);
    check(matches.length === 1, "frozen receipt membership mismatch");
    const ref = matches[0]!;
    check(ref.path === basename(ref.path), "uncontained frozen capture path");
    const capture = Capture.parse(read(join(home, ref.path), ref.sha256, 2 * 1024 * 1024));
    check(capture.ordinal === row.ordinal && capture.question_id === row.question_id
      && capture.interpretation_clock === row.interpretation_clock, "frozen capture input identity mismatch");
    const derived = admitFrozenQueries(row, capture.captures);
    check(canonicalJson(capture.pool) === canonicalJson(derived.pool)
      && canonicalJson(capture.occurrences) === canonicalJson(derived.occurrences), "frozen full-witness membership mismatch");
    check(canonicalJson(capture.solved.rows.map(item => item.record_id)) === canonicalJson(derived.solved.rows.map(item => item.record_id)),
      "frozen solved order disagrees with native field authority");
    return { ordinal: row.ordinal, question_id: row.question_id, capture_sha256: ref.sha256,
      captures: capture.captures, nomination: derived.nomination };
  });
  return { family: option.family, origin: { source_revision: receipt.source_revision, receipt_sha256: option.receipt.sha256,
    input_sha256: receipt.input_sha256 }, rows,
    inherited_costs: { local_query_inputs: receipt.local_query_inputs ?? null, distinct_cached_queries: receipt.distinct_cached_queries ?? null,
      external_calls: receipt.external_calls ?? null, index_builds: receipt.index_builds ?? null,
      note: "Inherited producer evidence only; per-query preparation/acquisition meters are retained in rows, not new delivery cost." } };
}
export type FrozenNominations = NonNullable<ReturnType<typeof admitFrozenNominations>>;

/** Same canonical phase/full-witness/profile identities as current producers.
 * Missing status/identity fails parsing; unknown and valid-empty stay distinct. */
export function admitFrozenQueries(row: RunRow, captures: FrozenQueries) {
  const expected = row.expected_index;
  check(expected !== null, "frozen nominations require a prepared index binding");
  check(expected.profile_id === sourceIndexProfileId(expected.configuration.profile, fieldContractSha256)
    && expected.config_id === sourceIndexConfigurationId(expected.configuration, fieldContractSha256)
    && expected.generation_id === sourceIndexGenerationId({ ...expected, workspace_id: row.workspace }, expected.source_epoch, fieldContractSha256),
    "frozen prepared identity mismatch");
  check(captures.length === 1 && captures[0]?.condition === row.original, "frozen condition membership mismatch");
  const query = captures[0]!, { phase, preparation, witness } = query, result = phase.result;
  check(sourceSemanticRetainedWitnessMatchesPhase(witness, phase), "frozen full nomination witness/phase mismatch");
  const digest = `sha256:${fieldContractSha256(row.conditions[0]!.query)}`;
  check(preparation.navigation_digest === digest && (result === null || result.navigation_digest === digest), "frozen query input digest mismatch");
  const selected = preparation.selected;
  check(selected !== null && selected.selection_revision === expected.selection_revision && selected.config_id === expected.config_id
    && selected.profile_id === expected.profile_id && canonicalJson(selected.profile) === canonicalJson(expected.configuration.profile),
    "frozen preparation profile mismatch");
  check(phase.policy === "source-index-interleaved-prefix.v1" && phase.channels === "dual", "unsupported frozen acquisition policy");
  const vector = result?.vector;
  if (witness.some(hit => hit.route.kind === "vector")) {
    const state = vector?.state;
    check(preparation.status === "ready" && vector?.input.status === "available" && vector.input.profile_id === expected.profile_id
      && vector.input.input_digest === digest && state !== null && state !== undefined && "binding" in state
      && ["ready", "partial", "valid_empty"].includes(state.status)
      && canonicalJson(state.binding) === canonicalJson({ workspace_id: row.workspace, selection_revision: expected.selection_revision,
        config_id: expected.config_id, profile_id: expected.profile_id, generation_id: expected.generation_id,
        source_epoch: expected.source_epoch, dimensions: expected.configuration.profile.dimensions }), "frozen vector binding mismatch");
  }
  const ranks = new Map<string, number>();
  for (const hit of witness) {
    const lane = result?.lanes.find(lane => lane.view === hit.view && lane.route === hit.route.kind);
    check(hit.view === "original" && hit.source.target.workspace_id === row.workspace && lane?.availability.status === "captured"
      && hit.route.native_rank > (ranks.get(hit.route.kind) ?? 0) && hit.route.native_rank <= (lane.last_native_rank ?? 0),
      "frozen native occurrence scope/lane mismatch");
    ranks.set(hit.route.kind, hit.route.native_rank);
  }
  const inventory = navigationInventory(captures), solved = solveConditionalNavigation({ ...row, ...inventory });
  check(solved.single_condition_equivalent === true, "frozen common field order mismatch");
  const known = phase.status === "executed" && phase.accounting === "complete" && result !== null
    && (result.completion === "complete" || result.completion === "partial");
  const nomination = !known || witness.length === 0 && result?.completion !== "complete" ? "unknown"
    : witness.length === 0 ? "measured_empty" : "witnessed";
  return { ...inventory, solved, nomination };
}

export function frozenAdmissionAccounting(ordinal: number) {
  return { ordinal, status: "running" as "running" | "complete" | "failed", scope_reads: navigationReadAccounting(),
    index_guard: { status: "complete" as "complete" | "partial", calls: 0, work: 0, native_bytes: 0,
      sql_internal_work: "unknown" as const } };
}
/** Existing readDocument owns generation/epoch/target/currentness/erase admission.
 * A body_capacity result at limit zero proves only its completed guard, never a
 * successful body read. Scope/identity is admitted via the bounded native reader. */
export function admitFrozenSources(row: RunRow, captures: FrozenQueries, database: StorageDatabase,
  repository: SqliteSourceIndexRepository, accounting: ReturnType<typeof frozenAdmissionAccounting>) {
  const { targets } = admitFrozenQueries(row, captures);
  const records = new SqliteFieldSourceRecordRepo(database, fieldContractSha256), meter = accounting.index_guard;
  try {
    for (const source of targets.values()) {
      meter.calls++;
      let guarded;
      try { guarded = repository.readDocument(row.workspace, row.expected_index!.generation_id, source.root_key, 0,
        { work: NAVIGATION_SOURCE_READ_ALLOWANCE.work_units, native_bytes: NAVIGATION_SOURCE_READ_ALLOWANCE.native_bytes }); }
      catch (error) {
        meter.status = "partial";
        if (error instanceof SourceIndexOperationError) { meter.work += error.resources.work; meter.native_bytes += error.resources.native_bytes; }
        throw error;
      }
      meter.work += guarded.resources.work; meter.native_bytes += guarded.resources.native_bytes;
      check(guarded.status === "ready" || guarded.status === "partial" && guarded.reason === "body_capacity", "frozen source index admission unavailable");
      const read = readNavigationSource(records, row.workspace, source.target.root_id, 1, accounting.scope_reads);
      check(read !== null && read.record !== null && read.record.source_body !== null && !read.invalidOffset && !read.resourceLimited,
        "frozen native source admission unavailable");
      const record = read.record;
      authorizeSemanticScope(record.scope_class, row.authorized_scopes);
      check(canonicalJson(sourceIndexTarget({ kind: "source_evidence", workspace_id: record.workspace_id, root_kind: "source_record",
        root_id: record.record_id, source_version: record.source_version, content_digest: record.content_digest,
        evidence_object_id: record.evidence_object_id }, record.source_id, read.bodyBytes)) === canonicalJson(source), "frozen native source identity mismatch");
    }
    accounting.status = "complete";
  } catch (error) { accounting.status = "failed"; throw error; }
}
