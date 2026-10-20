import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { canonicalJson, indexEntryCacheKey, sourceSemanticQueryIdentity, SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP,
  SourceSemanticResourceExhausted, WorkspaceKind, WorkspaceState, type SoulInterpretationResponse, type SourceSemanticWorkerRequest,
  type SourceSemanticWorkerResult } from "@do-soul/alaya-protocol";
import { createAuditedSourceAdmission, encodeSourceSemanticLibraryResponse, fieldContractSha256,
  selectSourceSemanticLibraryPage, sourceGoldRootIdentity, sourceSemanticLibraryQueryIdentity,
  sourceSemanticLibraryRequestIdentity, type SourceSemanticLibraryPackage } from "@do-soul/alaya-core";
import { closeCachedDatabase, SqliteEventLogRepo, SqliteWorkspaceRepo } from "@do-soul/alaya-storage";
import { createDaemonFieldRepos } from "../../../runtime/field/field-repos.js";
import { createSqliteFieldFormationStores } from "../../../runtime/field/sqlite-field-formation-stores.js";
import { SourceSemanticReadBudget, sourceSemanticReadStores } from "../../../runtime/field/source-semantic-read-stores.js";
import { createRecallReadWorkerRuntime } from "../../../runtime/recall-read-worker/runtime.js";
import { accessInputIdentity } from "../../../runtime/recall-read-worker/source-semantic-candidate-access.js";
import { bindAccessPoolIdentity, sourceSemanticAccessReceiptValue }
  from "../../../runtime/recall-read-worker/source-semantic-access-receipts.js";
import { deliverFrozenLibraryPage, prepareLibraryDelivery, type LibraryPageSelector }
  from "../../../runtime/recall-read-worker/source-semantic-library-delivery.js";
import { createRecallRealStorage } from "../../../../../../packages/core/src/__tests__/shared/real-sqlite.test-support.js";
import { CLOCK } from "../../../../../../packages/core/src/__tests__/recall/runtime/source-semantic-proof-fixture.js";
import { compatibleTaskSupport, physicalRoot, selectionExecutionBudget, type SelectionTaskFixture }
  from "../../../../../../packages/core/src/__tests__/recall/runtime/source-semantic-selection-fixture.js";
import { createLibraryExposureMeter, type ExposureSource } from "./source-semantic-library-exposure.test-support.js";

type Request = Extract<SourceSemanticWorkerRequest, { kind: "recall" }>;
type Recall = Extract<SourceSemanticWorkerResult, { kind: "recall" }>;
type PublicRecall = Extract<SoulInterpretationResponse, { operation: "recall" }>;
const WS = "ws", SCOPES = ["project"], ROOMY_BYTES = 1_000_000;
export const roomyDeliveryBytes = ROOMY_BYTES;

type Work = ReturnType<typeof work>;
type SelectionRegion = "baseline" | "final_envelope" | "same_root_post_pass";

/** Observe existing debit boundaries, never the selector's function identity. */
class ReservationMeter extends SourceSemanticReadBudget {
  public encoded: PublicRecall | undefined;
  readonly reservations = new Map<string, PublicRecall>();
  readonly phases: Record<string, { logical_work: number; logical_bytes: number }> = {};
  readonly regions: { region: SelectionRegion; logical_work: number; logical_bytes: number }[] = [];
  readonly rejections: { phase: string; work: number; bytes: number; remaining_work: number; remaining_bytes: number }[] = [];
  private region: SelectionRegion | undefined;
  private before = { logical_work: 0, logical_bytes: 0 };
  private trailingAccess = { logical_work: 0, logical_bytes: 0 };

  override reserve(work: number, bytes: number, phase = "preparation"): void {
    try { super.reserve(work, bytes, phase); }
    catch (error) {
      if (error instanceof SourceSemanticResourceExhausted) this.rejections.push({ phase, work, bytes,
        remaining_work: this.work, remaining_bytes: this.bytes });
      throw error;
    }
  }
  override charge(units: number, bytes: number, phase = "preparation"): void {
    const boundary = phase === "library page root census" ? "baseline"
      : phase === "final proof candidates" ? "final_envelope" : undefined;
    if (boundary !== undefined) this.finish();
    if (phase === "library pair source identity" && this.region !== "same_root_post_pass") {
      this.finish(); this.begin("same_root_post_pass");
    }
    super.charge(units, bytes, phase);
    const total = this.phases[phase] ??= { logical_work: 0, logical_bytes: 0 };
    total.logical_work += units; total.logical_bytes += bytes;
    if (phase === "access trace selection" || phase === "access trace delivery") {
      this.trailingAccess.logical_work += units; this.trailingAccess.logical_bytes += bytes;
    } else this.trailingAccess = { logical_work: 0, logical_bytes: 0 };
    if (boundary !== undefined) this.begin(boundary);
  }
  private begin(region: SelectionRegion): void {
    this.region = region; this.before = { logical_work: this.spentWork, logical_bytes: this.spentBytes };
  }
  finish(emptyPlan = false): void {
    if (this.region === undefined) return;
    // An empty plan projects one access receipt outside the last selector call.
    const tail = emptyPlan ? this.trailingAccess : { logical_work: 0, logical_bytes: 0 };
    this.regions.push({ region: this.region, logical_work: this.spentWork - this.before.logical_work - tail.logical_work,
      logical_bytes: this.spentBytes - this.before.logical_bytes - tail.logical_bytes });
    this.region = undefined;
  }
  override retain(value: unknown, phase?: string): void {
    super.retain(value, phase);
    if (phase === "candidate delivery encoding" || phase === "candidate partial delivery encoding") {
      const encoded = value as SoulInterpretationResponse;
      if (encoded.operation !== "recall") throw new Error("library recall reservation expected");
      this.encoded = encoded;
      if (encoded.delivery_id !== undefined) this.reservations.set(encoded.delivery_id, encoded);
    }
  }
}

export type NativeSubsetContext = Awaited<ReturnType<typeof nativeSubsetContext>>;
export async function nativeSubsetContext(fixture: SelectionTaskFixture) {
  const directory = await mkdtemp(join(tmpdir(), "library-subset-packing-")), filename = join(directory, "alaya.db");
  const { database } = await createRecallRealStorage(() => undefined, filename);
  try {
    await new SqliteWorkspaceRepo(database).create({ workspace_id: WS, name: "frozen source delivery",
      root_path: directory, workspace_kind: WorkspaceKind.LOCAL_REPO,
      default_engine_binding: null, workspace_state: WorkspaceState.ACTIVE });
    const admission = createAuditedSourceAdmission({
      stores: createSqliteFieldFormationStores({ database, repos: createDaemonFieldRepos({ database }) }),
      eventLogRepo: new SqliteEventLogRepo(database), runtimeNotifier: { notifyEntry: async () => undefined },
      sha256: fieldContractSha256
    });
    for (const source of fixture.sources) await admission.admit({ workspace_id: WS, source_id: source.id,
      source_version: "1", content_bytes: source.body, evidence_object_id: null, recorded_at: CLOCK,
      event_time: null, valid_from: null, valid_to: null, speaker: null, scope_class: "project", spans: [] }, { workspaceId: WS });
    const runtime = createRecallReadWorkerRuntime(database), setupMeter = new SourceSemanticReadBudget(selectionExecutionBudget);
    const exposure_sources: ExposureSource[] = [];
    const observations = fixture.sources.map(source => {
      const stores = sourceSemanticReadStores(database, WS, source.id, setupMeter, SCOPES);
      const current = stores.getCurrentRecord(WS, source.id), proofRecord = source.package.proofs[0]!.source_record;
      expect(current?.identity).toBe(proofRecord.identity);
      expect(current?.content_digest).toBe(proofRecord.content_digest);
      const stored = stores.getStoredRecord(WS, proofRecord.identity);
      expect(stored?.content_bytes).toBe(source.body);
      if (current === null || stored === null) throw new Error("admitted exposure source expected");
      exposure_sources.push({ record: current, body: stored.content_bytes });
      const bytes = Buffer.byteLength(source.body);
      return { source_id: source.id, record_id: proofRecord.identity, read_bytes: bytes, body_bytes: bytes, complete: true,
        signal: { source_text_score: 0, interpretation_reading_score: 0 } };
    });
    const inputId = accessInputIdentity(fixture.original, fixture.semantics, selectionExecutionBudget, "query-conditioned-v1");
    const receipt = sourceSemanticAccessReceiptValue(setupMeter, "query-conditioned-v1", inputId,
      observations, [], false, false, []);
    const pool = { sources: exposure_sources.map(source => source.record), descriptors: [],
      access: bindAccessPoolIdentity(runtime, WS, SCOPES, receipt, setupMeter), sourcePages: 1, interpretationPages: 0 };
    setupMeter.retain(pool.access, "fixture source pool identity");
    return { fixture, runtime, pool, exposure_sources, setup_work: work(setupMeter), close: async () => {
      database.close(); closeCachedDatabase(filename); await rm(directory, { recursive: true, force: true });
    } };
  } catch (error) {
    database.close(); closeCachedDatabase(filename); await rm(directory, { recursive: true, force: true }); throw error;
  }
}

function requestAndBase(context: NativeSubsetContext, limit: number) {
  const { fixture, pool } = context;
  const semantic_correspondences = fixture.pool.flatMap(row => row.proofs.map(proof => proof.semantic_correspondence));
  const request: Request = { kind: "recall", accepts_unreviewed_conditional_results: true,
    original_query: fixture.original, query_semantics: fixture.semantics, semantic_correspondences,
    budget: selectionExecutionBudget, output_byte_limit: limit, access_policy: "query-conditioned-v1" };
  const query_semantics_status = { status: "admitted" as const,
    query_semantics_id: sourceSemanticQueryIdentity(fixture.semantics, fieldContractSha256) };
  const base: Parameters<typeof prepareLibraryDelivery>[0] = {
    query_id: sourceSemanticLibraryQueryIdentity(fixture.original), snapshot_id: pool.access.pool_id,
    interpretation_id: "library", as_of: CLOCK, expires_at: "2026-09-18T00:05:00.000Z", authorized: SCOPES, pool,
    request_identity: fieldContractSha256(canonicalJson({ ...request, continuation: undefined })),
    public_request_identity: sourceSemanticLibraryRequestIdentity({ workspace_id: WS, as_of: CLOCK,
      authorized_scopes: SCOPES, original_query: fixture.original, query_semantics: fixture.semantics,
      query_semantics_status, semantic_correspondences, budget: selectionExecutionBudget,
      output_byte_limit: limit, access_policy: "query-conditioned-v1" }),
    query_semantics_status, unproved_computations: [],
    coverage: { discovery: "complete", source_interpretation: "open", query_semantics: "complete",
      semantic_correspondence: "open", conditional_computation: "complete", payload: "complete" },
    discovery: { eligible_source_count: fixture.sources.length, visited_source_pages: 1,
      visited_source_interpretation_pages: 0, visited_source_interpretation_descriptors: 0,
      candidate_prefix: [], examined_source_interpretation_ids: [], unexamined_source_interpretation_count: 0,
      omitted_duplicate_bindings: 0, examination_cap: SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP,
      open_residuals: false, truncated: false }
  };
  return { request, base };
}

const membership = (rows: readonly SourceSemanticLibraryPackage[]) => rows.map(physicalRoot).sort().join("\n");
const reservationKey = (rows: readonly SourceSemanticLibraryPackage[]) => canonicalJson(rows.map(row => ({
  entry: indexEntryCacheKey(row.entry), basis: row.selection_basis,
  proofs: row.proofs.map(proof => proof.conditional_computation_id)
})));
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
function work(meter: SourceSemanticReadBudget) {
  return { logical_work: meter.spentWork, logical_bytes: meter.spentBytes,
    native_work: meter.nativeWork, native_bytes: meter.nativeBytes };
}

export function measureNativeSubset(context: NativeSubsetContext, limit: number,
  desired?: readonly SourceSemanticLibraryPackage[], candidates = context.fixture.pool,
  selector: LibraryPageSelector = selectSourceSemanticLibraryPage) {
  const { request, base } = requestAndBase(context, limit), meter = new ReservationMeter(selectionExecutionBudget);
  let first = true, probe: { fits: boolean; encoded: PublicRecall } | undefined;
  let reserved: PublicRecall | undefined;
  const select: LibraryPageSelector = input => {
    if (!first) return selector(input);
    first = false;
    if (desired !== undefined) {
      const fits = input.fits(desired);
      if (meter.encoded === undefined) throw new Error("native subset reservation was not encoded");
      probe = { fits, encoded: meter.encoded };
    }
    const seen = new Map<string, PublicRecall>();
    const selected = selector({ ...input, candidates: desired ?? input.candidates, fits: page => {
      const fits = input.fits(page);
      if (fits && meter.encoded !== undefined) seen.set(reservationKey(page), meter.encoded);
      return fits;
    } });
    reserved = seen.get(reservationKey(selected));
    return selected;
  };
  // Forced-subset probes deliberately remain custom selectors. Ordinary measurements
  // must pass the exact selector object so production's same-root post-pass runs.
  // Forced alternatives must be explicit inventory members before the neutral
  // owner can reserve them; the materializer cannot introduce a new package.
  const inventory = desired === undefined ? candidates
    : [...candidates, ...desired.filter(row => !candidates.includes(row))];
  const plan = prepareLibraryDelivery(base, inventory, request, meter, "field", desired === undefined ? selector : select);
  meter.finish(plan.pages.every(page => page.length === 0));
  const selector_work = meter.regions.reduce((sum, row) => ({ logical_work: sum.logical_work + row.logical_work,
    logical_bytes: sum.logical_bytes + row.logical_bytes }), { logical_work: 0, logical_bytes: 0 });
  const preparation_work = work(meter), deliveryMeter = new SourceSemanticReadBudget(selectionExecutionBudget);
  const payload = { workspace_id: WS, as_of: CLOCK,
    authorized_scopes: { mode: "named" as const, scopes: SCOPES }, request };
  // Pair policies against the same empty process-local lease inventory. Reuse
  // this runtime for their continuation pages, not leases left by an earlier arm.
  const delivery_runtime = createRecallReadWorkerRuntime(context.runtime.database);
  const native = deliverFrozenLibraryPage(delivery_runtime, payload, deliveryMeter, request, plan, 0);
  const encoded = encodeSourceSemanticLibraryResponse(native);
  if (encoded.operation !== "recall" || encoded.results === undefined) throw new Error("public membership page expected");
  reserved ??= meter.reservations.get(native.delivery_id);
  const delivered = fixtureTaskSupportPackages(context.fixture, encoded);
  const exposure_meter = createLibraryExposureMeter();
  const exposure = exposure_meter.observe(native, encoded, context.exposure_sources);
  return { plan, request, native, encoded, reserved, probe, delivered, delivery_runtime,
    exposure, exposure_meter, exposure_pages: [exposure],
    selected_roots: delivered.map(physicalRoot), selected_sources: sourceNames(context.fixture, delivered),
    desired_sources: desired === undefined ? null : sourceNames(context.fixture, desired),
    reserved_bytes: reserved === undefined ? null : bytes(reserved),
    probe_bytes: probe === undefined ? null : bytes(probe.encoded),
    encoded_bytes: bytes(encoded), preparation_work, delivery_work: work(deliveryMeter), selector_work,
    selector_regions: meter.regions, preparation_phases: meter.phases, budget_rejections: meter.rejections,
    support: compatibleTaskSupport(context.fixture, delivered),
    qualifiers: native.slot_qualifiers.map(row => row.support),
    limit, actual_subset: desired === undefined || membership(delivered) === membership(desired) };
}

export type NativeMeasurement = ReturnType<typeof measureNativeSubset>;
// Authored task-support controls need fixture metadata. This root-only reconstruction
// is not an authority for delivered spans or proofs; exposure reads native/public output.
function fixtureTaskSupportPackages(fixture: SelectionTaskFixture, encoded: PublicRecall) {
  return (encoded.results ?? []).map(result => {
    if (result.target?.kind !== "source_evidence") throw new Error("source evidence target expected");
    const identity = sourceGoldRootIdentity(result.target);
    const row = fixture.pool.find(row => physicalRoot(row) === identity);
    if (row === undefined) throw new Error("delivered source outside frozen task");
    return { ...row, preview: result.content_preview };
  });
}

function sourceNames(fixture: SelectionTaskFixture, rows: readonly SourceSemanticLibraryPackage[]) {
  return rows.map(row => fixture.sources.find(source => physicalRoot(source.package) === physicalRoot(row))!.id).sort();
}

export function assertNativeSupport(fixture: SelectionTaskFixture, measurement: NativeMeasurement) {
  expect(measurement.encoded_bytes).toBeLessThanOrEqual(measurement.limit);
  expect(measurement.encoded.results?.every(row => row.budget_state.within_budget)).toBe(true);
  for (const row of measurement.delivered) {
    expect(row.preview).toBe(fixture.sources.find(source => physicalRoot(source.package) === physicalRoot(row))!.body);
  }
  expect(measurement.native.proofs).toEqual(measurement.plan.pages[0]!.flatMap(row => row.proofs));
  if (measurement.native.proofs === undefined) throw new Error("delivered proof array expected");
  for (const proof of measurement.native.proofs) {
    expect(proof.world_claim).toBe("unknown"); expect(proof.semantic_status).toBe("unreviewed");
  }
  for (const qualifier of measurement.qualifiers) {
    if (qualifier === undefined) throw new Error("source-local query support qualifier expected");
    expect(qualifier.answer).toBe("unrepresented"); expect(qualifier.operation).toBe("not_executed");
    expect(qualifier.compatibility).toBe("unknown"); expect(qualifier.distinctness).toBe("unknown");
  }
}

export async function persistMeasurement(caseName: string, name: string, measurement: NativeMeasurement) {
  await persistArtifact(caseName, `${name}.json`, measurementSummary(measurement));
  await persistArtifact(caseName, `${name}.delivered.json`, measurement.encoded);
  if (measurement.reserved !== undefined) await persistArtifact(caseName, `${name}.reserved.json`, measurement.reserved);
  if (measurement.probe !== undefined) await persistArtifact(caseName, `${name}.probe.json`, measurement.probe.encoded);
}

export function measurementSummary(measurement: NativeMeasurement) {
  const { selected_roots, selected_sources, desired_sources, reserved_bytes, probe_bytes, encoded_bytes,
    preparation_work, delivery_work, support, qualifiers, limit, actual_subset, probe, native } = measurement;
  return { selected_roots, selected_sources, desired_sources, reserved_bytes, probe_bytes, encoded_bytes,
    preparation_work, delivery_work, support, support_basis: "authored_fixture_statements_and_alternative_completeness" as const,
    qualifiers, limit, actual_subset, probe_fits: probe?.fits ?? null,
    first_page_exposure: measurement.exposure, exposure_pages: [...measurement.exposure_pages],
    planned_pages: measurement.plan.pages.length, exposure_pages_observed: measurement.exposure_pages.length,
    reserved_plan_fully_observed: measurement.exposure_pages.length === measurement.plan.pages.length,
    coverage: native.coverage, discovery: native.discovery, continuation: native.index.continuation };
}

export async function persistArtifact(caseName: string, name: string, value: unknown) {
  const root = process.env["ALAYA_SELECTION_DELIVERY_REPORT_DIR"];
  if (root === undefined) return;
  const directory = join(root, caseName);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, name), JSON.stringify(value), { encoding: "utf8", flag: "wx" });
}

export function deliverAllPages(context: NativeSubsetContext, measurement: NativeMeasurement,
  observe?: (page: Recall, cost: Work) => void): readonly Recall[] {
  // The first public call already happened in measureNativeSubset: reuse it and
  // its actual cost instead of issuing and charging page 1 a second time.
  let offset = 0;
  return measurement.plan.pages.map((page, index) => {
    if (index === 0) {
      observe?.(measurement.native, measurement.delivery_work);
      offset += page.length;
      return measurement.native;
    }
    const meter = new SourceSemanticReadBudget(selectionExecutionBudget);
    const result = deliverFrozenLibraryPage(measurement.delivery_runtime, { workspace_id: WS, as_of: CLOCK,
      authorized_scopes: { mode: "named", scopes: SCOPES }, request: measurement.request },
    meter, measurement.request, measurement.plan, offset);
    const encoded = encodeSourceSemanticLibraryResponse(result);
    if (encoded.operation !== "recall") throw new Error("public recall exposure page expected");
    measurement.exposure_pages[index] ??= measurement.exposure_meter.observe(result, encoded, context.exposure_sources);
    observe?.(result, work(meter));
    offset += page.length;
    return result;
  });
}
