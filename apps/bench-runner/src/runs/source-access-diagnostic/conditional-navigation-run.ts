import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { z } from "zod";
import { AlayaError, SourceIndexConfigurationSchema, canonicalJson, sourceIndexTarget,
  SOURCE_SEMANTIC_PROFILED_ACCESS_CONTRACT, SOURCE_SEMANTIC_PROFILED_LIBRARY_RESULT_VERSION,
  SOURCE_SEMANTIC_PROFILED_LIBRARY_PROTOCOL_VERSION,
  type SourceIndexQueryVector } from "@do-soul/alaya-protocol";
import { SourceIndexAcquisition, LocalOnnxEmbeddingClient, acquireProfiledSourceIndex, authorizeSemanticScope,
  fieldContractSha256, resolveSourceSemanticComparisonProfile } from "@do-soul/alaya-core";
import { sourceRecordFromRow, SqliteSourceIndexRepository, SqliteFieldSourceRecordRepo, StorageDatabase } from "@do-soul/alaya-storage";
import { solveConditionalNavigation, NAVIGATION_CONTRACT, NAVIGATION_LIMITS, type NavigationOccurrence } from "./conditional-navigation.js";
import { INPUT_NAVIGATION_POLICY, FormationCaptureSchema, admitInputFormation, mechanicalFormation, formationQueryShares } from "./input-condition-formation.js";

import { bindSourceRecordsObservation } from "../snapshot/source-records/observation-projection.js";
import { ObservationWindowSchema, TEMPORAL_NAVIGATION_DOMAIN } from "./temporal-navigation.js";
import { StructuralNavigationSchema, STRUCTURAL_LIMITS, structuralReadLedger, observeSessionAdjacency, structuralNavigationStatus,
  NAVIGATION_SOURCE_READ_ALLOWANCE, navigationReadAccounting, readNavigationSource, type ReadAccounting,
  type NavigationSourceRead, type StructuralReadLedger } from "./structural-navigation.js";

const Condition = z.object({ id: z.string().min(1), object: z.string().min(1), hypothesis: z.string().min(1),
  query: z.string().min(1).max(16384), status: z.enum(["ready", "partial", "unknown", "unsupported", "rejected"]),
  residual: z.string().nullable(), provenance: z.string().min(1), observation_window: ObservationWindowSchema.optional() }).strict();
const Binding = z.object({ configuration: SourceIndexConfigurationSchema, config_id: z.string(), profile_id: z.string(),
  selection_revision: z.number().int(), generation_id: z.string(), source_epoch: z.number().int(),
  status: z.enum(["ready", "valid_empty"]), enumeration_complete: z.literal(true),
  target_count: z.number().int(), completed_count: z.number().int() }).strict();
export const ConditionalNavigationRunSchema = z.object({
  contract: z.literal(NAVIGATION_CONTRACT), source_revision: z.string().min(1),
  cache_root: z.string().min(1), model_id: z.string().min(1).optional(), channels: z.enum(["dual", "lexical"]).default("dual"),
  comparison: z.object({ model: z.array(z.object({ ordinal: z.number().int().min(1).max(8), capture: FormationCaptureSchema }).strict()).max(8) }).strict().optional(),
  rows: z.array(z.object({ ordinal: z.number().int().min(1).max(8), question_id: z.string().min(1),
    snapshot: z.string().min(1), snapshot_sha256: z.string().regex(/^[a-f0-9]{64}$/u), workspace: z.string().min(1),
    source_records: z.object({ snapshot: z.string().min(1),
      manifest_sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict().optional(),
    observation_domain: z.literal(TEMPORAL_NAVIGATION_DOMAIN).optional(),
    structural_navigation: StructuralNavigationSchema.optional(),
    interpretation_clock: z.string().datetime(), authorized_scopes: z.array(z.string()).nullable(),
    expected_index: Binding.nullable(), original: z.string().min(1), conditions: z.array(Condition).min(1).max(1 + NAVIGATION_LIMITS.additional_conditions),
    branches: z.array(z.array(z.string()).min(1).max(NAVIGATION_LIMITS.additional_conditions)).max(NAVIGATION_LIMITS.branches) }).strict()).min(1).max(8)
}).strict();
const MAX_SCRATCH = 2 * 1024 ** 3, MAX_OUTPUT = 256 * 1024 ** 2, MAX_WALL = 3600_000;
const PREVIEW_BYTES = 4096;
type RunRow = z.infer<typeof ConditionalNavigationRunSchema>["rows"][number];
type ObservationScan = {
  ordinal: number; question_id: string; arm: string; domain: RunRow["observation_domain"];
  status: "running" | "complete" | "failed"; failure: string | null; candidates: number; admitted_sources: number;
  accounting: ReadAccounting;
  allowance: { candidates: number; prefix_bytes_per_candidate: number; work_units_per_candidate: number; native_bytes_per_candidate: number;
    seed_prefix_bytes?: number };
  artifact_inspection: ReturnType<typeof bindSourceRecordsObservation>["accounting"];
};
type DeliveryReads = { ordinal: number; question_id: string; arm: string; accounting: ReadAccounting; reused_delivery_reads: number };
type RunMetrics = { inferenceInputs: number; peakScratch: number; acquisitions: number; acquisitionHits: number;
  observationScans: ObservationScan[]; structuralReads: { ordinal: number; arm: string; ledger: StructuralReadLedger }[]; deliveryReads: DeliveryReads[] };
type Share = ReturnType<typeof formationQueryShares> extends Map<string, infer S> ? S : never;
function check(test: boolean, message: string): asserts test {
  if (!test) throw new AlayaError("VALIDATION", message);
}
export function navigationFileDigest(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function formArms(config: z.infer<typeof ConditionalNavigationRunSchema>, row: RunRow) {
  solveConditionalNavigation({ ...row, occurrences: [], pool: [] });
  check(!row.conditions.some(condition => condition.observation_window) || row.observation_domain === TEMPORAL_NAVIGATION_DOMAIN,
    "temporal navigation requires an explicit admitted nomination domain");
  check(!row.structural_navigation || row.observation_domain === TEMPORAL_NAVIGATION_DOMAIN,
    "structural navigation requires an explicit admitted nomination domain");
  check(!row.structural_navigation || !config.comparison, "structural comparison uses separately frozen supplied arms");
  const original = row.conditions.find(item => item.id === row.original)!;
  check(original?.status === "ready", "original query must remain independently ready");
  if (!config.comparison) return [{ arm: "supplied", row, formation: null, available: true }];
  check(row.conditions.length === 1 && row.branches.length === 0, "comparison input must be original-only");
  const input = { question: original.query, reference_clock: row.interpretation_clock };
  const model = config.comparison.model.find(item => item.ordinal === row.ordinal)?.capture
    ?? { task: INPUT_NAVIGATION_POLICY, input, state: "unavailable" as const,
      raw_json: null, provenance: "no-bound-model-proposal", reason: "No lawfully bound model proposal supplied." };
  return [{ arm: "original", row, formation: null, available: true }, ...[
    ["mechanical", mechanicalFormation(input)] as const, ["model", model] as const
  ].map(([arm, capture]) => {
    const formation = admitInputFormation(capture, input, [original.id]);
    const formed = { ...row, conditions: [original, ...formation.conditions], branches: formation.branches };
    solveConditionalNavigation({ ...formed, occurrences: [], pool: [] });
    return { arm, row: formed, formation, available: formation.available };
  })];
}

/** Selection has no label import. Formation captures freeze before SQLite or local inference.
 * One sealed database copy is live at a time; memoization never crosses scope/budget/snapshot identity. */
export async function runConditionalNavigation(value: unknown, output: string) {
  const config = ConditionalNavigationRunSchema.parse(value), root = resolve(output), started = performance.now();
  check(!existsSync(root), "navigation output must be a new directory");
  check(new Set(config.rows.map(row => row.ordinal)).size === config.rows.length
    && new Set(config.rows.map(row => row.question_id)).size === config.rows.length, "duplicate pilot membership");
  check(!config.comparison || new Set(config.comparison.model.map(row => row.ordinal)).size === config.comparison.model.length
    && config.comparison.model.every(item => config.rows.some(row => row.ordinal === item.ordinal)), "ambiguous model capture membership");
  const plans = config.rows.map(row => {
    check(config.channels === "lexical" || row.expected_index !== null, "dual navigation requires a prepared index binding");
    return { row, arms: formArms(config, row) };
  });
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "input.json"), JSON.stringify(config));
  writeFileSync(join(root, "formations.json"), JSON.stringify(plans.map(({ row, arms }) => ({ ordinal: row.ordinal,
    arms: arms.map(item => ({ arm: item.arm, available: item.available, formation: item.formation,
      conditions: item.row.conditions, branches: item.row.branches,
      shares: Object.fromEntries(formationQueryShares(item.row.conditions, config.comparison !== undefined || item.row.structural_navigation !== undefined)) })) }))));
  const scratch = mkdtempSync(join(root, "scratch-"));
  const client = config.channels === "dual" ? new LocalOnnxEmbeddingClient({ cacheDir: config.cache_root,
    ...(config.model_id === undefined ? {} : { modelId: config.model_id }) }) : null;
  const memo = new Map<string, Awaited<ReturnType<typeof SourceIndexAcquisition.prepareQuery>>>();
  const rows: { ordinal: number; question_id: string; arm: string; status: string; path?: string; sha256?: string;
    single_condition_equivalent?: boolean | null; nominations?: number; windows?: number }[] = [];
  const metrics: RunMetrics = { inferenceInputs: 0, peakScratch: 0, acquisitions: 0, acquisitionHits: 0, observationScans: [], structuralReads: [], deliveryReads: [] };
  let failure: string | null = null;
  try {
    for (const { row, arms } of plans) {
      check(performance.now() - started < MAX_WALL, "pilot wall limit reached");
      const sourceBytes = statSync(row.snapshot).size;
      check(sourceBytes + 65536 <= MAX_SCRATCH, "prepared snapshot exceeds scratch bound");
      check(navigationFileDigest(row.snapshot) === row.snapshot_sha256, "prepared snapshot digest mismatch");
      for (const suffix of ["-wal", "-journal"]) check(!existsSync(row.snapshot + suffix)
        || statSync(row.snapshot + suffix).size === 0, `sealed export has nonempty ${suffix}; reuse requires reconciliation`);
      const projectSourceTime = bindSourceRecordsObservation(row);
      const filename = join(scratch, "library.sqlite"); copyFileSync(row.snapshot, filename);
      metrics.peakScratch = Math.max(metrics.peakScratch, sourceBytes);
      const connection = new BetterSqlite3(filename, { readonly: true, fileMustExist: true });
      const database = new StorageDatabase(filename, connection);
      try {
        const repository = new SqliteSourceIndexRepository(database, fieldContractSha256);
        const state = repository.state(row.workspace), selection = "selection" in state ? state.selection : null;
        admitPreparedBinding(row, repository, state);
        const acquired = new Map<string, ReturnType<typeof acquire>>();
        for (const plan of arms) {
          const arm = plan.row, prefix = `${String(row.ordinal).padStart(3, "0")}${config.comparison ? `-${plan.arm}` : ""}`;
          if (!plan.available) {
            rows.push({ ordinal: row.ordinal, question_id: row.question_id, arm: plan.arm, status: `formation_${plan.formation!.state}` });
            continue;
          }
          rows.push(await captureNavigationArm({ arm, name: plan.arm, prefix, root, scratch, config, started,
            repository, database, connection, selection, memo, client, acquired, metrics, projectSourceTime }));
        }
      } finally { database.close({ optimize: false }); rmSync(filename, { force: true });
        for (const suffix of ["-wal", "-shm"]) rmSync(filename + suffix, { force: true }); }
      check(navigationFileDigest(row.snapshot) === row.snapshot_sha256, "immutable prepared input changed");
    }
  } catch (error) { failure = error instanceof Error ? error.message : String(error); }
  finally {
    try { await client?.close(); } catch (error) { failure ??= `cleanup: ${String(error)}`; }
    rmSync(scratch, { recursive: true, force: true });
  }
  const receipt = { contract: NAVIGATION_CONTRACT, source_revision: config.source_revision,
    status: failure === null ? "complete" : "stopped", failure, rows, input_sha256: navigationFileDigest(join(root, "input.json")),
    formations_sha256: navigationFileDigest(join(root, "formations.json")),
    local_query_inputs: config.comparison ? memo.size : metrics.inferenceInputs, local_inference_inputs: metrics.inferenceInputs,
    distinct_cached_queries: memo.size, acquisitions: metrics.acquisitions, acquisition_cache_hits: metrics.acquisitionHits, external_calls: 0, index_builds: 0,
    observation_scans: metrics.observationScans, delivery_reads: metrics.deliveryReads,
    ...(metrics.structuralReads.length ? { structural_reads: metrics.structuralReads } : {}),
    bounds: { questions: 8, local_query_inputs: config.comparison ? 56 : 32, wall_ms: MAX_WALL, scratch_bytes: MAX_SCRATCH, retained_bytes: MAX_OUTPUT },
    allocation: config.comparison ? "original-half-remainder-even-no-refill.v1" : config.rows.some(row => row.structural_navigation !== undefined)
      ? "explicit-structural-shared-otherwise-legacy" : "legacy-per-condition",
    ...(metrics.structuralReads.length ? { structural_question_allowance: {
      acquisition_work_units: 50_000_000, shared_read_work_units: STRUCTURAL_LIMITS.work_units,
      total_native_work_units: 50_000_000 + STRUCTURAL_LIMITS.work_units,
      note: "Fixed acquisition/read partitions; no refill. SQLite internal work remains unknown; artifact visits and solver steps are separate." } } : {}),
    per_question_arm_allowance: { max_attempts: 128, max_roots: 16, max_vector_windows: 4096, work_units: 50_000_000, memory_bytes: 60_000_000 },
    read_allowance_per_question_arm: { windows: 10, utf8_bytes_per_window: PREVIEW_BYTES, work_units: 1_000_000, native_bytes: 1280 * 1024 },
    scratch_peak_bytes: metrics.peakScratch, retained_bytes_before_receipt: retainedBytes(root), wall_ms: performance.now() - started,
    historical_replay: "not_established_missing_old_witnesses" };
  writeFileSync(join(root, "receipt.json"), JSON.stringify(receipt, null, 2));
  return receipt;
}
type ArmContext = {
  arm: RunRow; name: string; prefix: string; root: string; scratch: string; started: number;
  config: z.infer<typeof ConditionalNavigationRunSchema>; repository: SqliteSourceIndexRepository;
  database: StorageDatabase; connection: BetterSqlite3.Database;
  selection: Awaited<Parameters<typeof SourceIndexAcquisition.prepareQuery>[0]>["selection"];
  memo: Map<string, Awaited<ReturnType<typeof SourceIndexAcquisition.prepareQuery>>>;
  client: LocalOnnxEmbeddingClient | null; acquired: Map<string, ReturnType<typeof acquire>>;
  metrics: RunMetrics;
  projectSourceTime: ReturnType<typeof bindSourceRecordsObservation>;
};

/** One arm observes its allocated inputs, solves the field, then reads and freezes literal delivery. */
async function captureNavigationArm(ctx: ArmContext) {
  const { arm, name, prefix, root, scratch, started, config, repository, database, connection, selection, memo, client, acquired, metrics } = ctx;
  const shares = formationQueryShares(arm.conditions, config.comparison !== undefined || arm.structural_navigation !== undefined);
  const captures: { condition: string; preparation: unknown; phase: ReturnType<typeof acquire>["phase"];
    witness: ReturnType<typeof acquire>["witness"]; share: Share; memoized: boolean }[] = [];
  const occurrences: NavigationOccurrence[] = [], targets = new Map<string, ReturnType<typeof sourceIndexTarget>>();
  for (const condition of arm.conditions) {
    const share = shares.get(condition.id); if (!share) continue;
    check(performance.now() - started < MAX_WALL, "pilot wall limit reached");
    const key = canonicalJson([selection?.profile_id, config.channels, condition.query]);
    let prepared = memo.get(key);
    if (prepared === undefined) {
      check(memo.size < (config.comparison ? 56 : 32), "local query input cap reached");
      prepared = await SourceIndexAcquisition.prepareQuery({ navigation: condition.query, selection,
        bind: options => { check(client !== null, "local client unavailable"); return client.bindSourceEmbedding(options); },
        signal: AbortSignal.timeout(Math.min(90_000, MAX_WALL - (performance.now() - started))),
        remainingMs: () => Math.min(90_000, MAX_WALL - (performance.now() - started)) }, config.channels);
      metrics.inferenceInputs += prepared.receipt.submitted_inputs; memo.set(key, prepared);
    }
    check(config.channels === "lexical" || prepared.receipt.status === "ready", `query preparation ${prepared.receipt.status}`);
    const acquisitionKey = canonicalJson([condition.query, share]), memoized = acquired.has(acquisitionKey);
    const captured = acquired.get(acquisitionKey) ?? connection.transaction(() => acquire(arm, repository,
      condition.query, prepared!.vector, config.channels, share))();
    if (memoized) metrics.acquisitionHits++; else { metrics.acquisitions++; acquired.set(acquisitionKey, captured); }
    captures.push({ condition: condition.id, preparation: prepared.receipt, phase: captured.phase, witness: captured.witness, share, memoized });
    writeFileSync(join(root, `${prefix}-observations.json`), JSON.stringify(captures));
    check(captured.phase.status === "executed" && captured.phase.accounting === "complete", "native acquisition failed or unknown");
    for (const witness of captured.witness) {
      check(witness.source.target.root_kind === "source_record", "prototype requires native source-record targets");
      const id = witness.source.target.root_id; targets.set(id, witness.source);
      occurrences.push({ condition: condition.id, channel: witness.route.kind, native_rank: witness.route.native_rank,
        reference: `${condition.id}:${witness.reference}`, root_key: witness.source.root_key, record_id: id });
    }
  }
  const pool = [...targets.keys()].sort().map((record_id, catalog_position) => ({ record_id, catalog_position }));
  // The optional scan is also available to a no-time control, keeping its domain
  // and source-read work matched. Every member binds before any field selection.
  const ledger = arm.structural_navigation ? structuralReadLedger(arm.structural_navigation) : undefined;
  if (ledger) metrics.structuralReads.push({ ordinal: arm.ordinal, arm: name, ledger });
  const originalNominee = arm.structural_navigation ? solveConditionalNavigation({ ...arm, pool, occurrences }).original_nominee : null;
  const originalResult = captures.find(row => row.condition === arm.original)?.phase.result;
  // An admitted-empty query is not a denied/stale nomination admission.
  if (arm.structural_navigation && arm.structural_navigation.mode !== "off" && originalNominee === null) {
    check(!originalResult?.counts.denied, "original native nomination admission denied");
  }
  const completion = originalResult?.completion ?? "unknown";
  const nomination = { status: originalNominee !== null ? "witnessed" as const
    : completion === "complete" ? "measured_empty" as const : "unknown" as const, completion, occurrence: originalNominee };
  const seedId = arm.structural_navigation && arm.structural_navigation.mode !== "off" ? originalNominee?.record_id : undefined;
  // Keep delivery effects even without structural opt-in, on admission failure,
  // transaction rollback, or a later capture-write failure. Scans remain separate.
  const delivery: DeliveryReads = { ordinal: arm.ordinal, question_id: arm.question_id, arm: name,
    accounting: navigationReadAccounting(), reused_delivery_reads: 0 };
  metrics.deliveryReads.push(delivery);
  const cached = new Map<string, NavigationSourceRead>();
  const { observation, structural, solved, windows } = connection.transaction(() => {
    const observation = arm.observation_domain === undefined ? undefined :
      observeCandidateSources(arm, name, database, targets, ctx.projectSourceTime, metrics.observationScans, ledger, seedId, cached);
    const read = seedId === undefined ? undefined : cached.get(seedId);
    if (seedId !== undefined) {
      check(read !== undefined && read !== null && read.prefixBytes > 0, "structural seed read unavailable or empty");
    }
    const structural = arm.structural_navigation ? { config: arm.structural_navigation, nomination,
      observation: observeSessionAdjacency(observation!.sources, seedId && read ? {
        record_id: seedId, prefix_bytes: read.prefixBytes, body_bytes: read.bodyBytes } : null) } : undefined;
    const solved = solveConditionalNavigation({ ...arm, pool, occurrences, source_observations: observation?.sources, structural });
    check(solved.single_condition_equivalent !== false, "same-input native C order mismatch");
    const windows = readSelectedWindows(arm, database, solved.rows, targets, ctx.projectSourceTime, delivery, ledger, cached);
    return { observation, structural, solved, windows };
  })();
  const scratchBytes = readdirSync(scratch).reduce((sum, file) => sum + statSync(join(scratch, file)).size, 0);
  check(scratchBytes <= MAX_SCRATCH, "scratch limit exceeded"); metrics.peakScratch = Math.max(metrics.peakScratch, scratchBytes);
  const encoded = JSON.stringify({ ordinal: arm.ordinal, question_id: arm.question_id, arm: name, captures, occurrences, pool, solved, windows,
    ...(structural ? { structural: { ...structural, reads: ledger } } : {}),
    ...(observation === undefined ? {} : { observation: { domain: arm.observation_domain, ...observation,
      artifact_inspection: ctx.projectSourceTime.accounting, evaluations: solved.temporal_observations?.length ?? 0 } }),
    inventory: "admitted_nomination_union", interpretation_clock: arm.interpretation_clock,
    tail: { status: pool.length <= 10 ? "exhausted" : "open", reason: "closed_admitted_inventory_only" } });
  check(Buffer.byteLength(encoded) + retainedBytes(root) < MAX_OUTPUT, "retained output limit reached");
  const path = `${prefix}.json`; writeFileSync(join(root, path), encoded);
  rmSync(join(root, `${prefix}-observations.json`));
  return { ordinal: arm.ordinal, question_id: arm.question_id, arm: name,
    status: structural ? structuralNavigationStatus(structural.config.mode, structural.nomination.status, structural.observation.status) : "complete", path,
    sha256: navigationFileDigest(join(root, path)), single_condition_equivalent: solved.single_condition_equivalent,
    nominations: targets.size, windows: windows.length };
}
function acquire(row: RunRow, repository: SqliteSourceIndexRepository, navigation: string, vector: SourceIndexQueryVector,
  channels: "dual" | "lexical", share: Share) {
  const profile = resolveSourceSemanticComparisonProfile({ comparison: { profile: {
    contract: SOURCE_SEMANTIC_PROFILED_ACCESS_CONTRACT, result_version: SOURCE_SEMANTIC_PROFILED_LIBRARY_RESULT_VERSION,
    protocol_version: SOURCE_SEMANTIC_PROFILED_LIBRARY_PROTOCOL_VERSION, order_policy: "native-route-round-robin-v1", acquisition_policy: "source-index-interleaved-prefix.v1",
    channels, declared_allowance: share.allowance } } });
  check(profile !== undefined, "private acquisition profile unavailable");
  return acquireProfiledSourceIndex({ repository, sha256: fieldContractSha256, workspace: row.workspace,
    original: { navigation, vector }, profile, budget: share.budget,
    admitScope: scope => { try { authorizeSemanticScope(scope, row.authorized_scopes); return "admitted"; } catch { return "denied"; } } });
}
function admitPreparedBinding(row: RunRow, repository: SqliteSourceIndexRepository,
  state: ReturnType<SqliteSourceIndexRepository["state"]>) {
  const expected = row.expected_index;
  if (expected === null) return;
  const generation = repository.generation(row.workspace, expected.generation_id);
  check("selection" in state && state.active_generation_id === expected.generation_id && generation !== null,
    "prepared active generation unavailable");
  const selection = state.selection;
  check(canonicalJson(selection.configuration) === canonicalJson(expected.configuration)
    && selection.profile_id === expected.profile_id && selection.config_id === expected.config_id
    && selection.selection_revision === expected.selection_revision && generation.source_epoch === expected.source_epoch
    && generation.status === expected.status && generation.enumeration_complete
    && generation.target_count === expected.target_count && generation.completed_count === expected.completed_count,
  "prepared profile/generation/coverage mismatch");
}
function readSelectedWindows(row: RunRow, database: StorageDatabase,
  selected: ReturnType<typeof solveConditionalNavigation>["rows"], targets: ReadonlyMap<string, ReturnType<typeof sourceIndexTarget>>,
  projectSourceTime: ReturnType<typeof bindSourceRecordsObservation>, delivery: DeliveryReads, ledger?: StructuralReadLedger,
  cached: ReadonlyMap<string, NavigationSourceRead> = new Map()) {
  const records = new SqliteFieldSourceRecordRepo(database, fieldContractSha256);
  return selected.slice(0, 10).map((item, index) => {
    const target = targets.get(item.record_id)!;
    const reuse = cached.get(item.record_id);
    const read = reuse ?? readNavigationSource(records, row.workspace, item.record_id, PREVIEW_BYTES,
      delivery.accounting, ledger);
    if (reuse) { delivery.reused_delivery_reads++; if (ledger) ledger.reused_delivery_reads++; }
    check(read !== null && read.record !== null && read.record.source_body !== null && !read.invalidOffset && !read.resourceLimited,
      "authorized source window unavailable");
    check(read.record.content_digest === target.target.content_digest && read.record.source_version === target.target.source_version,
      "source read identity changed");
    authorizeSemanticScope(read.record.scope_class, row.authorized_scopes);
    return { rank: index + 1, source_id: target.source_id, target: target.target, start: 0, end: read.prefixBytes,
      source_time: projectSourceTime(sourceRecordFromRow(read.record)),
      text: read.record.source_body, read: { status: read.prefixBytes === read.bodyBytes ? "complete" : "partial",
        body_bytes: read.bodyBytes, native_bytes: read.nativeBytes + read.metadataBytes } };
  });
}
/** The existing bounded Storage reader and complete projection join own admission.
 * Minimum one-byte probes are NOT seeds. Only the designated seed's larger,
 * nonempty read is cached and may be reused for literal delivery in this transaction. */
function observeCandidateSources(row: RunRow, arm: string, database: StorageDatabase,
  targets: ReadonlyMap<string, ReturnType<typeof sourceIndexTarget>>, project: ReturnType<typeof bindSourceRecordsObservation>, scans: ObservationScan[],
  ledger?: StructuralReadLedger, seedId?: string, cached = new Map<string, NavigationSourceRead>()) {
  const scan: ObservationScan = { ordinal: row.ordinal, question_id: row.question_id, arm, domain: row.observation_domain,
    status: "running", failure: null, candidates: targets.size, admitted_sources: 0,
    accounting: navigationReadAccounting(),
    allowance: { candidates: 512, prefix_bytes_per_candidate: 1,
      work_units_per_candidate: NAVIGATION_SOURCE_READ_ALLOWANCE.work_units, native_bytes_per_candidate: NAVIGATION_SOURCE_READ_ALLOWANCE.native_bytes,
      ...(seedId === undefined ? {} : { seed_prefix_bytes: STRUCTURAL_LIMITS.seed_prefix_bytes }) },
    artifact_inspection: project.accounting };
  // Read effects outlive a rolled-back scan and a capture that was never published.
  scans.push(scan);
  const { accounting, allowance } = scan;
  try {
    check(targets.size <= allowance.candidates, "source observation domain exceeds navigation bound");
    const records = new SqliteFieldSourceRecordRepo(database, fieldContractSha256);
    const sources = [...targets].map(([record_id, target]) => {
      const read = readNavigationSource(records, row.workspace, record_id,
        record_id === seedId ? STRUCTURAL_LIMITS.seed_prefix_bytes : allowance.prefix_bytes_per_candidate, accounting, ledger);
      check(read !== null && read.record !== null && read.record.source_body !== null && !read.invalidOffset && !read.resourceLimited,
        "source observation admission unavailable");
      authorizeSemanticScope(read.record.scope_class, row.authorized_scopes);
      check(read.record.source_id === target.source_id && read.record.content_digest === target.target.content_digest
        && read.record.source_version === target.target.source_version, "source observation acquisition identity changed");
      const source_time = project(sourceRecordFromRow(read.record));
      if (record_id === seedId) cached.set(record_id, read);
      scan.admitted_sources++;
      return { record_id, source_time };
    });
    scan.status = "complete";
    return { sources, accounting, allowance };
  } catch (error) {
    scan.status = "failed"; scan.failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally { accounting.status = accounting.unmetered_reads === 0 ? "complete" : "partial"; }
}
function retainedBytes(root: string) {
  return readdirSync(root).filter(path => path.endsWith(".json")).reduce((sum, path) => sum + statSync(join(root, path)).size, 0);
}
