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
import { SqliteSourceIndexRepository, SqliteFieldSourceRecordRepo, StorageDatabase } from "@do-soul/alaya-storage";
import { solveConditionalNavigation, NAVIGATION_CONTRACT, type NavigationOccurrence } from "./conditional-navigation.js";

const Condition = z.object({ id: z.string().min(1), object: z.string().min(1), hypothesis: z.string().min(1),
  query: z.string().min(1).max(16384), status: z.enum(["ready", "partial", "unknown", "unsupported", "rejected"]),
  residual: z.string().nullable(), provenance: z.string().min(1) }).strict();
const Binding = z.object({ configuration: SourceIndexConfigurationSchema, config_id: z.string(), profile_id: z.string(),
  selection_revision: z.number().int(), generation_id: z.string(), source_epoch: z.number().int(),
  status: z.enum(["ready", "valid_empty"]), enumeration_complete: z.literal(true),
  target_count: z.number().int(), completed_count: z.number().int() }).strict();
export const ConditionalNavigationRunSchema = z.object({
  contract: z.literal(NAVIGATION_CONTRACT), source_revision: z.string().min(1),
  cache_root: z.string().min(1), channels: z.enum(["dual", "lexical"]).default("dual"),
  rows: z.array(z.object({ ordinal: z.number().int().min(1).max(8), question_id: z.string().min(1),
    snapshot: z.string().min(1), snapshot_sha256: z.string().regex(/^[a-f0-9]{64}$/u), workspace: z.string().min(1),
    interpretation_clock: z.string().datetime(), authorized_scopes: z.array(z.string()).nullable(),
    expected_index: Binding.nullable(), original: z.string().min(1), conditions: z.array(Condition).min(1).max(4),
    branches: z.array(z.array(z.string()).min(1).max(3)).max(3) }).strict()).min(1).max(8)
}).strict();
const ALLOWANCE = { max_attempts: 128, max_roots: 16, max_vector_windows: 4096 };
const BUDGET = { work_units: 50_000_000, memory_bytes: 60_000_000 };
const MAX_SCRATCH = 2 * 1024 ** 3, MAX_OUTPUT = 256 * 1024 ** 2, MAX_WALL = 3600_000;
const PREVIEW_BYTES = 4096;

type RunRow = z.infer<typeof ConditionalNavigationRunSchema>["rows"][number];
function check(test: boolean, message: string): asserts test {
  if (!test) throw new AlayaError("VALIDATION", message);
}
export function navigationFileDigest(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** No provider, publication, schema migration or index build entry is reachable here.
 * One sealed database copy is live at a time. Companion presence alone is not a writer signal. */
export async function runConditionalNavigation(value: unknown, output: string) {
  const config = ConditionalNavigationRunSchema.parse(value), root = resolve(output), started = performance.now();
  check(!existsSync(root), "navigation output must be a new directory");
  check(new Set(config.rows.map(row => row.ordinal)).size === config.rows.length
    && new Set(config.rows.map(row => row.question_id)).size === config.rows.length, "duplicate pilot membership");
  for (const row of config.rows) {
    // Admission also runs with an empty inventory, before any inference or SQLite open.
    solveConditionalNavigation({ ...row, occurrences: [], pool: [] });
    check(row.conditions.find(item => item.id === row.original)?.query.length !== undefined, "original query missing");
    check(config.channels === "lexical" || row.expected_index !== null, "dual navigation requires a prepared index binding");
  }
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "input.json"), JSON.stringify(config));
  const scratch = mkdtempSync(join(root, "scratch-"));
  const client = config.channels === "dual" ? new LocalOnnxEmbeddingClient({ cacheDir: config.cache_root }) : null;
  const memo = new Map<string, Awaited<ReturnType<typeof SourceIndexAcquisition.prepareQuery>>>();
  const rows: unknown[] = [];
  let inputs = 0, peakScratch = 0, failure: string | null = null;
  try {
    for (const row of config.rows) {
      check(performance.now() - started < MAX_WALL, "pilot wall limit reached");
      const sourceBytes = statSync(row.snapshot).size;
      check(sourceBytes + 65536 <= MAX_SCRATCH, "prepared snapshot exceeds scratch bound");
      check(navigationFileDigest(row.snapshot) === row.snapshot_sha256, "prepared snapshot digest mismatch");
      for (const suffix of ["-wal", "-journal"]) check(!existsSync(row.snapshot + suffix)
        || statSync(row.snapshot + suffix).size === 0, `sealed export has nonempty ${suffix}; reuse requires reconciliation`);
      const filename = join(scratch, "library.sqlite"); copyFileSync(row.snapshot, filename);
      peakScratch = Math.max(peakScratch, sourceBytes);
      const connection = new BetterSqlite3(filename, { readonly: true, fileMustExist: true });
      const database = new StorageDatabase(filename, connection);
      try {
        const repository = new SqliteSourceIndexRepository(database, fieldContractSha256);
        const state = repository.state(row.workspace);
        const selection = "selection" in state ? state.selection : null;
        admitPreparedBinding(row, repository, state);
        const captures: { condition: string; preparation: unknown; phase: unknown; witness: unknown }[] = [];
        const occurrences: NavigationOccurrence[] = [], targets = new Map<string, ReturnType<typeof sourceIndexTarget>>();
        for (const condition of row.conditions) {
          if (!["ready", "partial"].includes(condition.status)) continue;
          const key = canonicalJson([selection?.profile_id, config.channels, condition.query]);
          let prepared = memo.get(key);
          if (prepared === undefined) {
            check(inputs < 32, "local query input cap reached");
            prepared = await SourceIndexAcquisition.prepareQuery({ navigation: condition.query, selection,
              bind: options => { check(client !== null, "local client unavailable"); return client.bindSourceEmbedding(options); },
              signal: AbortSignal.timeout(Math.min(90_000, MAX_WALL - (performance.now() - started))),
              remainingMs: () => Math.min(90_000, MAX_WALL - (performance.now() - started)) }, config.channels);
            inputs += prepared.receipt.submitted_inputs; memo.set(key, prepared);
          }
          check(config.channels === "lexical" || prepared.receipt.status === "ready", `query preparation ${prepared.receipt.status}`);
          const captured = connection.transaction(() => acquire(row, repository, condition.query, prepared!.vector, config.channels))();
          captures.push({ condition: condition.id, preparation: prepared.receipt, phase: captured.phase, witness: captured.witness });
          // Preserve partial native facts even if a later condition or read fails.
          writeFileSync(join(root, `${String(row.ordinal).padStart(3, "0")}-observations.json`), JSON.stringify(captures));
          check(captured.phase.status === "executed" && captured.phase.accounting === "complete", "native acquisition failed or unknown");
          for (const witness of captured.witness) {
            check(witness.source.target.root_kind === "source_record", "prototype requires native source-record targets");
            const id = witness.source.target.root_id; targets.set(id, witness.source);
            occurrences.push({ condition: condition.id, channel: witness.route.kind, native_rank: witness.route.native_rank,
              reference: `${condition.id}:${witness.reference}`, root_key: witness.source.root_key, record_id: id });
          }
        }
        // Closed domain: union of admitted nominations, not an invented complete source universe.
        // The same explicit inventory is supplied to native C and the field kernel.
        const pool = [...targets.keys()].sort().map((record_id, catalog_position) => ({ record_id, catalog_position }));
        const solved = solveConditionalNavigation({ ...row, pool, occurrences });
        check(solved.single_condition_equivalent !== false, "same-input native C order mismatch");
        const windows = connection.transaction(() => readSelectedWindows(row, database, solved.rows, targets))();
        const scratchBytes = readdirSync(scratch).reduce((sum, name) => sum + statSync(join(scratch, name)).size, 0);
        check(scratchBytes <= MAX_SCRATCH, "scratch limit exceeded"); peakScratch = Math.max(peakScratch, scratchBytes);
        const result = { ordinal: row.ordinal, question_id: row.question_id, captures, occurrences, pool, solved, windows,
          inventory: "admitted_nomination_union", interpretation_clock: row.interpretation_clock,
          tail: { status: pool.length <= 10 ? "exhausted" : "open", reason: "closed_admitted_inventory_only" } };
        const encoded = JSON.stringify(result);
        check(Buffer.byteLength(encoded) + retainedBytes(root) < MAX_OUTPUT, "retained output limit reached");
        const path = `${String(row.ordinal).padStart(3, "0")}.json`;
        writeFileSync(join(root, path), encoded);
        rmSync(join(root, `${String(row.ordinal).padStart(3, "0")}-observations.json`)); rows.push({ ordinal: row.ordinal, question_id: row.question_id,
          path, sha256: navigationFileDigest(join(root, path)), single_condition_equivalent: solved.single_condition_equivalent,
          nominations: targets.size, windows: windows.length, solver: solved.solver });
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
    local_query_inputs: inputs, distinct_cached_queries: memo.size, external_calls: 0, index_builds: 0,
    bounds: { questions: 8, local_query_inputs: 32, wall_ms: MAX_WALL, scratch_bytes: MAX_SCRATCH, retained_bytes: MAX_OUTPUT },
    allowance_per_condition: ALLOWANCE, budget_per_condition: BUDGET, preview_bytes: PREVIEW_BYTES,
    scratch_peak_bytes: peakScratch, retained_bytes_before_receipt: retainedBytes(root), wall_ms: performance.now() - started,
    natural_multi_condition: config.rows.some(row => row.branches.length > 0) ? "supplied_proposals_not_fidelity_certified" : "unavailable",
    historical_replay: "not_established_missing_old_witnesses", byte_budget_metric: "follow_up_at_visibility_scorer" };
  writeFileSync(join(root, "receipt.json"), JSON.stringify(receipt, null, 2));
  return receipt;
}
function acquire(row: RunRow, repository: SqliteSourceIndexRepository, navigation: string, vector: SourceIndexQueryVector,
  channels: "dual" | "lexical") {
  const profile = resolveSourceSemanticComparisonProfile({ comparison: { profile: {
    contract: SOURCE_SEMANTIC_PROFILED_ACCESS_CONTRACT, result_version: SOURCE_SEMANTIC_PROFILED_LIBRARY_RESULT_VERSION,
    protocol_version: SOURCE_SEMANTIC_PROFILED_LIBRARY_PROTOCOL_VERSION, order_policy: "native-route-round-robin-v1", acquisition_policy: "source-index-interleaved-prefix.v1",
    channels, declared_allowance: ALLOWANCE } } });
  check(profile !== undefined, "private acquisition profile unavailable");
  return acquireProfiledSourceIndex({ repository, sha256: fieldContractSha256, workspace: row.workspace,
    original: { navigation, vector }, profile, budget: BUDGET,
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
  selected: ReturnType<typeof solveConditionalNavigation>["rows"], targets: ReadonlyMap<string, ReturnType<typeof sourceIndexTarget>>) {
  const records = new SqliteFieldSourceRecordRepo(database, fieldContractSha256);
  return selected.slice(0, 10).map((item, index) => {
    const target = targets.get(item.record_id)!;
    const read = records.findByIdBounded(row.workspace, item.record_id, PREVIEW_BYTES, 0,
      { workLimit: 100_000, nativeByteLimit: 128 * 1024 });
    check(read !== null && read.record !== null && read.record.source_body !== null && !read.invalidOffset && !read.resourceLimited,
      "authorized source window unavailable");
    check(read.record.content_digest === target.target.content_digest && read.record.source_version === target.target.source_version,
      "source read identity changed");
    authorizeSemanticScope(read.record.scope_class, row.authorized_scopes);
    return { rank: index + 1, source_id: target.source_id, target: target.target, start: 0, end: read.prefixBytes,
      text: read.record.source_body, read: { status: read.prefixBytes === read.bodyBytes ? "complete" : "partial",
        body_bytes: read.bodyBytes, native_bytes: read.nativeBytes + read.metadataBytes } };
  });
}
function retainedBytes(root: string) {
  return readdirSync(root).filter(path => path.endsWith(".json")).reduce((sum, path) => sum + statSync(join(root, path)).size, 0);
}
