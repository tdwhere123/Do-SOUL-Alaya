import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); });
afterAll(() => { isolation.restore(); });
import { buildSourceReferenceCatalog, sourceReferenceResolver, sourceSemanticInterpretationIdentity,
  sourceSemanticQueryIdentity, SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP, projectSourceSemanticQuerySupport,
  type SourceSemanticInterpretation, type SourceSemanticQuery, type SourceSemanticCorrespondence,
  type SourceSemanticWorkerRequest } from "@do-soul/alaya-protocol";
import { createAuditedSourceAdmission, fieldContractSha256, sourceSemanticLibraryQueryIdentity,
  executeSourceSemanticInterpretation, scopeSourceSemanticLibraryBranch, selectSourceSemanticLibraryPage,
  proofEntriesFromBranch, encodeSourceSemanticLibraryResponse, deliveredSourceSemanticLibraryProof,
  type SourceSemanticLibraryPackage } from "@do-soul/alaya-core";
import { SqliteEventLogRepo } from "@do-soul/alaya-storage";
import { createRecallRealStorage, REAL_SQLITE_TEST_WORKSPACE_ID as WS }
  from "../../../../../../packages/core/src/__tests__/shared/real-sqlite.test-support.js";
import { deliveredProofFixture, source, query, correspondenceFor, CLOCK }
  from "../../../../../../packages/core/src/__tests__/recall/runtime/source-semantic-proof-fixture.js";
import { createDaemonFieldRepos } from "../../../runtime/field/field-repos.js";
import { createSqliteFieldFormationStores } from "../../../runtime/field/sqlite-field-formation-stores.js";
import { SourceSemanticReadBudget } from "../../../runtime/field/source-semantic-read-stores.js";
import { createRecallReadWorkerRuntime } from "../../../runtime/recall-read-worker/runtime.js";
import { prepareLibraryPackages, prepareLibraryPackagePairs }
  from "../../../runtime/recall-read-worker/source-semantic-library-packages.js";
import { prepareLibraryDelivery, deliverFrozenLibraryPage }
  from "../../../runtime/recall-read-worker/source-semantic-library-delivery.js";
import { sourceSemanticAccessReceiptValue } from "../../../runtime/recall-read-worker/source-semantic-access-receipts.js";

const BUDGET = { schema_version: 1 as const, work_units: 10_000_000, memory_bytes: 200_000_000,
  page_budget: 100_000, finalization_reserve: 10_000, min_envelope: 10 };
const meter = () => new SourceSemanticReadBudget(BUDGET);
const predicates = ["permission granted", "backup completed"];
const original = `Collect these source statements: ${predicates.join("; ")}.`;
const semantics: SourceSemanticQuery = { ...query(original), return_variables: [],
  requested_operation: { reading: "collect statements", support: { kind: "query_text", excerpt: original } },
  variables: predicates.map((_, input) => ({ id: `p${input}`, sort: "proposition" as const })),
  alternatives: [{ frames: predicates.map((reading, input) => ({ id: `q${input}`, variable: `p${input}`,
    predicate_reading: reading, role_requirements: [] })),
  context_obligations: predicates.map((_, input) => ({ frame: `q${input}`, kind: "asserted_at_source" as const })),
  answer_frames: [], evidence_inputs: predicates.map((_, input) => ({ frames: [`q${input}`] })) }] };
const baselineSelector: typeof selectSourceSemanticLibraryPage = input => selectSourceSemanticLibraryPage(input);

function interpretation(body: string, sourceId: string, index: number): SourceSemanticInterpretation {
  const sentences = body.split("\n"), reading = predicates[index % 2]!;
  const catalog = buildSourceReferenceCatalog(fieldContractSha256(body), sentences.map((text, position) =>
    ({ assertion_id: position + 1, text })), fieldContractSha256);
  const resolver = sourceReferenceResolver(catalog, fieldContractSha256);
  const start = sentences.slice(0, index).reduce((bytes, text) => bytes + Buffer.byteLength(text) + 1, 0);
  const frame = { id: "fact", assertion_ids: [index + 1],
    context_owner: { kind: "source_act" as const, source_act: "assertion" as const }, additional_support: [],
    predicate_support: { kind: "explicit" as const, reading, mentions: ["statement"] }, slots: [], bindings: [] };
  return { ...source(), source: { ...source().source, source_id: sourceId, content_digest: `sha256:${fieldContractSha256(body)}`,
    assertion_locations: [{ assertion_id: index + 1, source_utf8_span: [start, start + Buffer.byteLength(sentences[index]!)] }] },
  mentions: [{ id: "statement", assertion_id: index + 1, text: reading, span_space: "source_utf8",
    utf8_span: [start, start + Buffer.byteLength(reading)], source_ref: resolver.referenceForSpan(index + 1, [0, reading.length]) }],
  referents: [], frames: [frame], operators: [], gaps: [], entry_roots: [frame.id], asserted_at_scope: [frame.id] };
}

function correspondence(h: SourceSemanticInterpretation, index: number): SourceSemanticCorrespondence {
  return { ...correspondenceFor(source(), query()),
    source_interpretation_id: sourceSemanticInterpretationIdentity(h, fieldContractSha256),
    query_semantics_id: sourceSemanticQueryIdentity(semantics, fieldContractSha256), correspondences: [{ relation: "contextual_equivalence",
      query_endpoint: { kind: "predicate", alternative: 0, frame: `q${index % 2}` }, source_endpoint: { kind: "frame", frame: "fact" },
      query_support: { kind: "query_text", excerpt: predicates[index % 2]! }, source_semantic_support: [{ kind: "lexical", mentions: ["statement"] }] }] };
}

async function createContext(count = 3) {
  const { database } = await createRecallRealStorage(() => undefined);
  const body = Array.from({ length: count }, (_, index) => `${predicates[index % 2]}.`).join("\n");
  const admission = createAuditedSourceAdmission({
    stores: createSqliteFieldFormationStores({ database, repos: createDaemonFieldRepos({ database }) }),
    eventLogRepo: new SqliteEventLogRepo(database), runtimeNotifier: { notifyEntry: async () => undefined }, sha256: fieldContractSha256
  });
  for (const sourceId of ["shared-source", "later-source"]) {
    await admission.admit({ workspace_id: WS, source_id: sourceId, source_version: "1", content_bytes: body, evidence_object_id: null,
      recorded_at: CLOCK, event_time: null, valid_from: null, valid_to: null, speaker: "user", scope_class: "project", spans: [] }, { workspaceId: WS });
  }
  const fixtures = [...Array.from({ length: count }, (_, index) => ({ index, sourceId: "shared-source" })),
    { index: 0, sourceId: "later-source" }].map(({ index, sourceId }) => {
    const h = interpretation(body, sourceId, index);
    return deliveredProofFixture({ interpretation: h, semantics, correspondence: correspondence(h, index), original,
      library: true, workspaceId: WS, budget: BUDGET });
  });
  const supports = fixtures.map(fixture => {
    const proof = fixture.proof;
    const executed = executeSourceSemanticInterpretation({ source_interpretation: proof.interpretation, query_semantics: proof.query,
      semantic_correspondence: proof.semantic_correspondence, original_query: original, workspaceId: WS, scope: "project",
      authorizedScopes: ["project"], asOf: CLOCK, sourceValidity: fixture.record, source_target: fixture.target,
      request: { contract: "source-interpretation-reasoning-v5", accepts_unreviewed_conditional_results: true,
        source_interpretation_id: proof.source_interpretation_id!, query_semantics_id: proof.query_semantics_id!,
        semantic_correspondence_id: proof.semantic_correspondence_id!, original_query: original, budget: BUDGET, output_byte_limit: 1_000_000 } });
    expect(executed.index).not.toBeNull();
    const scoped = scopeSourceSemanticLibraryBranch(executed.index!, executed.result);
    return { proof, group: proofEntriesFromBranch(scoped.index, scoped.result), source: body, dependencies: executed.source_dependencies ?? [] };
  });
  const request: Extract<SourceSemanticWorkerRequest, { kind: "recall" }> = { kind: "recall", accepts_unreviewed_conditional_results: true,
    original_query: original, query_semantics: semantics, budget: BUDGET, output_byte_limit: 1_000_000 };
  const payload = { workspace_id: WS, as_of: CLOCK, authorized_scopes: { mode: "named" as const, scopes: ["project"] }, request };
  return { database, body, fixtures, supports, request, payload, runtime: createRecallReadWorkerRuntime(database),
    sources: [fixtures[0]!.entry, fixtures[count]!.entry], records: [fixtures[0]!.record, fixtures[count]!.record] };
}
type Context = Awaited<ReturnType<typeof createContext>>;
let context: Context;
beforeAll(async () => { context = await createContext(); });
afterAll(() => { context?.database.close(); });

function packages(ctx: Context, roots = 1, supports = ctx.supports, authorized = ["project"]) {
  return prepareLibraryPackages(ctx.runtime, ctx.payload, authorized, meter(), ctx.sources.slice(0, roots), supports);
}
function base(ctx: Context, roots = 1): Parameters<typeof prepareLibraryDelivery>[0] {
  const records = ctx.records.slice(0, roots);
  return { query_id: sourceSemanticLibraryQueryIdentity(original), snapshot_id: `sha256:${"ef".repeat(32)}`, interpretation_id: "library",
    as_of: CLOCK, expires_at: "2026-09-18T00:05:00.000Z", authorized: ["project"],
    request_identity: `sha256:${"ff".repeat(32)}`, public_request_identity: `sha256:${"aa".repeat(32)}`,
    query_semantics_status: { status: "admitted", query_semantics_id: sourceSemanticQueryIdentity(semantics, fieldContractSha256) },
    unproved_computations: [], coverage: { discovery: "complete", source_interpretation: "complete", query_semantics: "complete",
      semantic_correspondence: "complete", conditional_computation: "complete", payload: "complete" },
    discovery: { eligible_source_count: roots, visited_source_pages: 1, visited_source_interpretation_pages: 0,
      visited_source_interpretation_descriptors: 0, candidate_prefix: [], examined_source_interpretation_ids: [],
      unexamined_source_interpretation_count: 0, omitted_duplicate_bindings: 0, examination_cap: SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP,
      open_residuals: false, truncated: false },
    pool: { sources: records, descriptors: [], sourcePages: 1, interpretationPages: 0,
      access: { ...sourceSemanticAccessReceiptValue("query-conditioned-v1", `sha256:${"ab".repeat(32)}`,
        records.map(record => ({ source_id: record.source_id, record_id: record.identity, read_bytes: Buffer.byteLength(ctx.body),
          body_bytes: Buffer.byteLength(ctx.body), complete: true, signal: { source_text_score: 0, interpretation_reading_score: 0 } })),
        [], false, false, []), pool_id: `sha256:${"cd".repeat(32)}` } } };
}
function deliver(ctx: Context, rows: readonly SourceSemanticLibraryPackage[], limit: number, options: {
  ledger?: SourceSemanticReadBudget; roots?: number; baseline?: boolean; order?: "field" | "source_access";
} = {}) {
  const request = { ...ctx.request, output_byte_limit: limit };
  const plan = prepareLibraryDelivery(base(ctx, options.roots), rows, request, options.ledger ?? meter(), options.order,
    options.baseline ? baselineSelector : selectSourceSemanticLibraryPage);
  const result = deliverFrozenLibraryPage(ctx.runtime, { ...ctx.payload, request }, meter(), request, plan, 0);
  const encoded = encodeSourceSemanticLibraryResponse(result);
  const reserved = encodeSourceSemanticLibraryResponse({ ...result, work: { native_work: BUDGET.work_units, logical_work: BUDGET.work_units,
    native_bytes: BUDGET.memory_bytes, logical_memory_bytes: BUDGET.memory_bytes, rss_bytes: Number.MAX_SAFE_INTEGER } });
  return { plan, result, bytes: Buffer.byteLength(JSON.stringify(encoded)), reserved_bytes: Buffer.byteLength(JSON.stringify(reserved)) };
}
function support(rows: readonly SourceSemanticLibraryPackage[]) {
  return projectSourceSemanticQuerySupport(semantics, rows.flatMap(row => row.proofs.flatMap(proof => proof.binding_results ?? [])));
}
function budgetForPair(ctx: Context) {
  const pair = packages(ctx, 1, ctx.supports.slice(0, 2)).packages.find(row => row.proofs.length === 2)!;
  return deliver(ctx, [pair], 1_000_000).reserved_bytes;
}

it("delivers complementary whole proofs when their same-root union exceeds the envelope", () => {
  const candidates = packages(context), limit = budgetForPair(context);
  expect(candidates.incomplete).toBe(false);
  expect(candidates.packages.map(row => row.proofs.length)).toEqual([3, 1, 1, 1, 0]);
  const baseline = deliver(context, candidates.packages, limit, { baseline: true });
  expect(baseline.result.proofs).toHaveLength(1);
  const actual = deliver(context, candidates.packages, limit);
  expect(actual.result.proofs).toHaveLength(2);
  expect(actual.plan.pages.map(page => page.length)).toEqual([1]);
  expect(actual.result.index.continuation).toBeNull();
  expect(actual.bytes).toBeLessThanOrEqual(limit);
  expect(support(actual.plan.pages[0]!)).toMatchObject({ answer: "unrepresented", operation: "not_executed",
    compatibility: "unknown", distinctness: "unknown", evidence_inputs: [{ status: "supported" }, { status: "supported" }] });
  for (const qualifier of actual.result.slot_qualifiers) {
    expect(deliveredSourceSemanticLibraryProof(actual.result.index, actual.result.index.entries[qualifier.index]!, qualifier,
      actual.result.proofs!, context.records[0]!, BUDGET).proof).toBeDefined();
  }
  expect(actual.result.proofs!.map(proof => proof.conditional_computation_id)).toEqual(
    context.supports.slice(0, 2).map(row => row.proof.conditional_computation_id));
  const all = candidates.packages.find(row => row.proofs.length === 3)!;
  expect(deliver(context, candidates.packages, deliver(context, [all], 1_000_000).reserved_bytes).result.proofs).toHaveLength(3);
});

it("keeps complete single proofs at the exact pair byte boundary and preserves source authority", () => {
  const candidates = packages(context).packages;
  let low = 30_000, high = budgetForPair(context);
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (deliver(context, candidates, mid).result.proofs?.length === 2) high = mid; else low = mid + 1;
  }
  const pair = deliver(context, candidates, low), smaller = deliver(context, candidates, low - 1);
  expect(pair.result.proofs).toHaveLength(2);
  expect(smaller.result.proofs).toHaveLength(1);
  expect(pair.bytes).toBeLessThanOrEqual(low);
  expect(smaller.bytes).toBeLessThanOrEqual(low - 1);
  expect(packages(context, 1, context.supports, ["global_core"]).packages).toHaveLength(0);
  const entry = pair.result.index.entries[0]!, qualifier = pair.result.slot_qualifiers[0]!;
  expect(deliveredSourceSemanticLibraryProof(pair.result.index, entry, qualifier, pair.result.proofs!,
    { ...context.records[0]!, source_version: "old-revision" }, BUDGET).proof).toBeUndefined();
  if (entry.target.kind !== "source_evidence" || entry.target.span === undefined) throw new Error("source span required");
  const clipped = { ...entry, target: { ...entry.target, span: { ...entry.target.span, content_end: 1 } } };
  expect(deliveredSourceSemanticLibraryProof(pair.result.index, clipped, qualifier, pair.result.proofs!,
    context.records[0]!, BUDGET).proof).toBeUndefined();
  const retained = packages(context, 1, [context.supports[0]!, context.supports[2]!]).packages;
  expect(support(deliver(context, retained, 1_000_000).plan.pages[0]!).evidence_inputs.map(row => row.status)).toEqual(["supported", "open"]);
});

it.each(["work_units", "memory_bytes"] as const)("preserves baseline pages with no spare %s for optional pairs", resource => {
  const candidates = packages(context).packages, limit = budgetForPair(context), measured = meter();
  const baseline = deliver(context, candidates, limit, { ledger: measured, baseline: true });
  const allowance = resource === "work_units" ? measured.spentWork : measured.spentBytes;
  const bounded = new SourceSemanticReadBudget({ ...BUDGET, [resource]: allowance });
  const actual = deliver(context, candidates, limit, { ledger: bounded });
  expect(actual.plan).toEqual(baseline.plan);
  expect(actual.result.proofs).toEqual(baseline.result.proofs);
  expect(resource === "work_units" ? bounded.spentWork : bounded.spentBytes).toBeLessThanOrEqual(allowance);
});

it("retains later roots, access receipts and continuation offsets when pairs do not fit", () => {
  const candidates = packages(context, 2).packages, limit = 40_000;
  const baseline = deliver(context, candidates, limit, { roots: 2, baseline: true });
  const actual = deliver(context, candidates, limit, { roots: 2 });
  expect(actual.plan.pages.map(page => page.length)).toEqual([1, 1]);
  expect(actual.plan).toEqual(baseline.plan);
  expect(actual.result.index.continuation).toMatchObject({ cursor: baseline.result.index.continuation!.cursor,
    query_id: baseline.result.index.continuation!.query_id, snapshot_id: baseline.result.index.continuation!.snapshot_id });
  const request = { ...context.request, output_byte_limit: limit };
  const later = deliverFrozenLibraryPage(context.runtime, { ...context.payload, request }, meter(), request, actual.plan, 1);
  expect(later.index.continuation).toBeNull();
  expect(later.proofs).toHaveLength(1);
  expect(later.index.entries[0]!.target).not.toEqual(actual.result.index.entries[0]!.target);
});

it("leaves source-access and custom selector routes unchanged and omits redundant pairs", () => {
  const candidates = packages(context).packages, limit = budgetForPair(context);
  const baseline = deliver(context, candidates, limit, { baseline: true });
  expect(baseline.result.proofs).toHaveLength(1);
  const access = deliver(context, candidates, limit, { order: "source_access" });
  const accessBaseline = deliver(context, candidates, limit, { order: "source_access", baseline: true });
  expect(access.plan).toEqual(accessBaseline.plan);
  const pairs = [...prepareLibraryPackagePairs(candidates, baseline.plan.pages[0]!, meter())];
  expect(pairs).toHaveLength(2);
  expect(pairs.every(row => support([row]).evidence_inputs.every(input => input.status === "supported"))).toBe(true);
});

it("pairs a bounded complementary population without spending baseline reservations", async () => {
  const many = await createContext(SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP);
  try {
    const candidates = packages(many).packages, limit = budgetForPair(many), measured = meter();
    const baseline = deliver(many, candidates, limit, { baseline: true, ledger: measured });
    expect(baseline.result.proofs).toHaveLength(1);
    const pairs = [...prepareLibraryPackagePairs(candidates, baseline.plan.pages[0]!, meter())];
    expect(pairs).toHaveLength(16 * 16);
    expect(pairs.every(row => row.proofs.length === 2)).toBe(true);
    const actual = deliver(many, candidates, limit, { ledger: new SourceSemanticReadBudget({ ...BUDGET, work_units: measured.spentWork }) });
    expect(actual.plan).toEqual(baseline.plan);
  } finally { many.database.close(); }
});
