import { join } from "node:path";
import { expect } from "vitest";
import { SoulInterpretationResponseSchema } from "@do-soul/alaya-protocol";
import { admitSourceSemanticQuery, authorizedScopesFromAdmission, sourceSemanticLibraryRequestIdentity,
  sourceSemanticQueryStatus } from "@do-soul/alaya-core";
import { chainIdentity, readChainArtifact, writeChainArtifact, type SemanticChainConfig,
  type SemanticChainPlan } from "../../../runs/semantic-chain/contract.js";
import { prepareSemanticChain } from "../../../runs/semantic-chain/prepare.js";
import { admitEmittedSourcePreview, measureSemanticChain } from "../../../runs/semantic-chain/replay.js";
import { interveneSemanticChain } from "../../../runs/semantic-chain/intervene.js";
import { readSemanticChainCorrespondences, readSemanticChainProposalResults, semanticChainProposalStates,
  semanticChainQueryCorrespondences } from "../../../runs/semantic-chain/inputs.js";
import { executeSemanticProposalFill, prepareSemanticProposal } from "../../../runs/semantic-proposal/fill.js";
import { pinSemanticProposalAuthority } from "../../../runs/semantic-proposal/authority.js";
import { isExtractionRequestProfile } from "../../../runs/extraction/request-profile.js";
import type { SourceGoldUnit } from "../../../runs/measurement/source-gold-join.js";

type ReadyQuery = Extract<SemanticChainPlan["queries"][number], { status: "ready" }>;
type ArchivedRow = { query_key: string; status: string; response?: unknown; first_exposure?: unknown;
  preparation_trace?: ReadyQuery["discovery_trace"] | null; native_elapsed_ms?: number;
  correspondence_outcomes?: ReturnType<typeof semanticChainQueryCorrespondences>["outcomes"]; [key: string]: unknown };
type Archive = { contract: string; plan_identity: string; identity: string;
  arm: "retained" | "without_semantic_correspondences"; provider_calls: 0; rows: ArchivedRow[] };
type Fixture = { root: string; plan: SemanticChainPlan; replayPath: string;
  gold: { query_key: string; source_units: SourceGoldUnit[] }[]; queryRawJson: string };

/** Keep the native fixture immutable; every counterfactual gets its own archive root. */
export async function assertSemanticChainArchiveAdmission(fixture: Fixture): Promise<void> {
  const original = readChainArtifact(fixture.replayPath) as Archive;
  const native = original.rows.find((row) => row.status === "replayed")!;
  const response = SoulInterpretationResponseSchema.parse(native.response);
  if (response.operation !== "recall") throw new Error("native recall fixture required");
  const archiveRoot = join(fixture.root, "archive-admission");
  const sourceUnits = fixture.gold.find((row) => row.query_key === native.query_key)!.source_units;
  const measure = (root: string, path: string, plan: SemanticChainPlan) => measureSemanticChain(root, path,
    plan.queries.map((query) => ({ query_key: query.query_key, source_units: sourceUnits })));
  const assertUnknown = (root: string, path: string, plan: SemanticChainPlan, key: string, reason: RegExp) => {
    const measured = measure(root, path, plan).result.rows;
    expect(measured.map((row) => row.query_key)).toEqual(plan.queries.map((row) => row.query_key));
    expect(measured.find((row) => row.query_key === key)).toMatchObject({ status: "native_unavailable",
      reason: expect.stringMatching(reason), measurement: null, source_bearing_union: null,
      mechanism: { status: "unexercised" } });
    const intervention = readChainArtifact(interveneSemanticChain(root, path).path) as { rows: { query_key: string; status: string }[] };
    expect(intervention.rows.find((row) => row.query_key === key)?.status).toBe("not_exercised");
  };

  const preparedChanges: [string, Partial<SemanticChainConfig>][] = [
    ["changed-clock", { interpretation_clock: "2026-09-21T02:00:00.000Z" }],
    ["changed-scope", { authorized_scopes: { mode: "named", scopes: ["global_core"] } }]
  ];
  for (const [name, config] of preparedChanges) {
    const root = join(archiveRoot, name);
    const plan = await prepareSemanticChain({ ...fixture.plan.config, ...config }, root);
    expect(plan.queries.find((query) => query.query_key === native.query_key)?.status).toBe("ready");
    const path = retainArchive(root, plan, transplantRows(plan, native));
    assertUnknown(root, path, plan, native.query_key, /archive_admission:.*another frozen request/u);
  }
  const anotherRoot = join(archiveRoot, "another-cached-question");
  const anotherPlan = await prepareAnotherCachedQuestion(fixture, anotherRoot);
  const another = anotherPlan.queries[0]!;
  expect(another.status).toBe("ready");
  expect(another.query_key).not.toBe(native.query_key);
  expect(another.original_query).not.toBe(fixture.plan.queries[0]!.original_query);
  assertUnknown(anotherRoot, retainArchive(anotherRoot, anotherPlan, transplantRows(anotherPlan, native)),
    anotherPlan, another.query_key, /archive_admission:.*another frozen request/u);

  // These are deliberately authored plan mutations, with current cache identities retained.
  const authoredChanges: [string, Partial<SemanticChainConfig>][] = [
    ["changed-workspace", { workspace_id: "another-source-workspace" }],
    ["changed-output-cap", { output_byte_limit: fixture.plan.config.output_byte_limit - 1 }],
    ["changed-budget", { budget: { ...fixture.plan.config.budget, work_units: fixture.plan.config.budget.work_units - 1 } }],
    ["changed-access-policy", { access_policy: "query-conditioned-v1" }]
  ];
  for (const [name, change] of authoredChanges) {
    const root = join(archiveRoot, name), config = { ...fixture.plan.config, ...change };
    const queries = readSemanticChainProposalResults(config.query_workset, config.query_cache_root, config.max_output_tokens);
    const plan = { ...fixture.plan, config, input_identity: chainIdentity({ config, queries: semanticChainProposalStates(queries) }) };
    assertUnknown(root, retainArchive(root, plan, transplantRows(plan, native)), plan, native.query_key,
      /archive_admission:.*another frozen request/u);
    if (name === "changed-output-cap") {
      const reboundRoot = join(archiveRoot, "rebound-request-with-old-delivery");
      const replay = readSemanticChainCorrespondences(plan, "retained");
      const query = plan.queries.find((entry) => entry.query_key === native.query_key)!;
      if (query.status !== "ready") throw new Error("ready query required");
      const requestIdentity = sourceSemanticLibraryRequestIdentity({ workspace_id: config.workspace_id,
        as_of: config.interpretation_clock, authorized_scopes: authorizedScopesFromAdmission(config.authorized_scopes).authorized_scopes!,
        original_query: query.original_query, query_semantics: query.query_semantics,
        query_semantics_status: sourceSemanticQueryStatus(admitSourceSemanticQuery(query.query_semantics, query.original_query)),
        budget: config.budget,
        semantic_correspondences: semanticChainQueryCorrespondences(query, replay.semantic_correspondences).ready,
        output_byte_limit: config.output_byte_limit, access_policy: config.access_policy });
      const changed = { ...native, response: { ...response, request_identity: requestIdentity } };
      assertUnknown(reboundRoot, retainArchive(reboundRoot, plan, transplantRows(plan, changed)), plan, native.query_key,
        /delivery ID does not bind/u);
    }
  }

  expect(native.correspondence_outcomes?.some((outcome) => outcome.cache_identity !== null)).toBe(true);
  const { response: _nativeResponse, ...withoutResponse } = native;
  const rowChanges: [string, ArchivedRow, RegExp][] = [
    ["changed-request-identity", { ...native, response: { ...response, request_identity: `sha256:${"0".repeat(64)}` } }, /another frozen request/u],
    ["changed-correspondence-cache-identity", { ...native, correspondence_outcomes: native.correspondence_outcomes!.map((outcome) =>
      outcome.cache_identity === null ? outcome : { ...outcome, cache_identity: "0".repeat(64) }) }, /another frozen request/u],
    ["unavailable-with-exposure", { ...withoutResponse, status: "native_unavailable" }, /unavailable row cannot have a native delivery/u],
    ["changed-preparation-trace", { ...native, preparation_trace: native.preparation_trace!.map((page, index) => index !== 0 ? page
      : { ...page, access: { ...page.access, observed_source_count: page.access.observed_source_count + 1 } }) }, /prepared access pool/u]
  ];
  for (const [name, changed, reason] of rowChanges) {
    const root = join(archiveRoot, name), rows = original.rows.map((row) => row.query_key === native.query_key ? changed : row);
    assertUnknown(root, retainArchive(root, fixture.plan, rows), fixture.plan, native.query_key, reason);
  }
  const qualifiers = response.slot_qualifiers;
  const proofOffset = qualifiers?.findIndex((slot) => slot.evidence_kind === "semantic_proof") ?? -1;
  const proofResult = response.results?.[proofOffset];
  if (proofOffset < 0 || proofResult?.target.kind !== "source_evidence" || qualifiers === undefined) {
    throw new Error("native proof preview fixture required");
  }
  const forgedPreview = { ...native, response: { ...response, results: response.results!.map((result, position) =>
    position === proofOffset ? { ...result, content_preview: "The unrelated mountain is purple." } : result) } };
  const forgedRoot = join(archiveRoot, "changed-supporting-body");
  assertUnknown(forgedRoot, retainArchive(forgedRoot, fixture.plan, original.rows.map((row) =>
    row.query_key === native.query_key ? forgedPreview : row)), fixture.plan, native.query_key,
  /archive_admission:.*preview differs from sealed source span/u);
  const omittedProof = { ...native, response: { ...response, results: response.results!.map((result, position) =>
    position === proofOffset ? { ...result, content_preview: "[payload omitted]",
      budget_state: { ...result.budget_state, within_budget: false } } : result),
    slot_qualifiers: qualifiers.map((slot, position) => position === proofOffset
      ? { ...slot, payload_support: "not_applicable" as const } : slot) } };
  const omittedRoot = join(archiveRoot, "omitted-proof-with-forged-qualifier");
  assertUnknown(omittedRoot, retainArchive(omittedRoot, fixture.plan, original.rows.map((row) =>
    row.query_key === native.query_key ? omittedProof : row)), fixture.plan, native.query_key,
  /archive_admission:.*complete emitted source preview/u);

  // The same admission uses the shared UTF-8 byte slicer for real prefixes and literal marker text.
  const source = "🙂[empty source] [payload omitted]";
  const span = { content_start: 4, content_end: Buffer.byteLength(source), retained_extent: "body" as const,
    content_complete: false, original_complete: false };
  const target = { ...proofResult.target, span };
  const result = { ...proofResult, target, content_preview: "[empty source] [payload omitted]" };
  expect(() => admitEmittedSourcePreview(span, result, qualifiers[proofOffset], target, source, true)).not.toThrow();
  const short = { ...result, content_preview: "[empty source]", budget_state: { ...result.budget_state, within_budget: false } };
  expect(() => admitEmittedSourcePreview(span, short, undefined, target, source, false)).not.toThrow();
  const marker = "[payload omitted]", markerSpan = { ...span, content_start: 0, content_end: Buffer.byteLength(marker) };
  expect(() => admitEmittedSourcePreview(markerSpan, { ...result, target: { ...target, span: markerSpan }, content_preview: marker },
    undefined, { ...target, span: markerSpan }, marker, false)).not.toThrow();
  const emptySpan = { ...span, content_start: 0, content_end: 0 };
  expect(() => admitEmittedSourcePreview(emptySpan, { ...result, target: { ...target, span: emptySpan }, content_preview: "[empty source]" },
    undefined, { ...target, span: emptySpan }, "", false)).not.toThrow();
  expect(() => admitEmittedSourcePreview(span, { ...short, content_preview: "[payload omitted]" },
    undefined, target, source, false)).not.toThrow();
  expect(() => admitEmittedSourcePreview({ ...span, content_start: 1 }, result, undefined, target, source, false))
    .toThrow(/UTF-8 slice/u);
  expect(() => admitEmittedSourcePreview({ ...span, content_start: 5 }, result, undefined, target, source, false))
    .toThrow(/preview differs|preview exceeds/u);
  const rawReady = fixture.plan.queries.find((query) => query.status === "raw_ready")!;
  const rawRoot = join(archiveRoot, "unavailable-query-with-foreign-proof");
  const rawRows = original.rows.map((row) => row.query_key !== rawReady.query_key ? row : { ...native, query_key: rawReady.query_key });
  assertUnknown(rawRoot, retainArchive(rawRoot, fixture.plan, rawRows), fixture.plan, rawReady.query_key,
    /another frozen request/u);
  const missingRoot = join(archiveRoot, "missing-reservation");
  assertUnknown(missingRoot, retainArchive(missingRoot, fixture.plan, original.rows, { omitReservation: native.query_key }),
    fixture.plan, native.query_key, /reservation differs/u);
  const reservationRoot = join(archiveRoot, "changed-reservation");
  assertUnknown(reservationRoot, retainArchive(reservationRoot, fixture.plan, original.rows, { changedReservation: native.query_key }),
    fixture.plan, native.query_key, /reservation differs/u);
  const mismatchRoot = join(archiveRoot, "retained-row-mismatch");
  assertUnknown(mismatchRoot, retainArchive(mismatchRoot, fixture.plan, original.rows, { changedRetainedRow: native.query_key }),
    fixture.plan, native.query_key, /native row.*differs/u);
  assertGlobalArchiveMismatches(fixture, archiveRoot, original, measure);

  // The original current-cache native hit remains admitted after every counterfactual.
  const positive = measureSemanticChain(fixture.root, fixture.replayPath, fixture.gold).result.rows
    .find((row) => row.query_key === native.query_key);
  expect(positive?.measurement).toMatchObject({ status: "validated",
    metrics: { proof_conditioned_first_exposure: { any_at_5: { status: "hit" } } } });
  expect(positive?.source_bearing_union?.any_at_5.status).toBe("hit");
}

function transplantRows(plan: SemanticChainPlan, native: ArchivedRow): ArchivedRow[] {
  const correspondences = readSemanticChainCorrespondences(plan, "retained").semantic_correspondences;
  return plan.queries.map((query) => query.status === "blocked" ? query : { ...native, query_key: query.query_key,
    correspondence_outcomes: query.status === "ready" ? semanticChainQueryCorrespondences(query, correspondences).outcomes : [] });
}

/** Repack actual native response/exposure bytes under the destination plan and retained paths. */
function retainArchive(root: string, plan: SemanticChainPlan, rows: ArchivedRow[],
  options: { omitReservation?: string; changedReservation?: string; changedRetainedRow?: string; identity?: string; planIdentity?: string } = {}): string {
  const identity = options.identity ?? readSemanticChainCorrespondences(plan, "retained").identity;
  writeChainArtifact(join(root, "prepare.json"), plan);
  for (const row of rows) {
    const path = join(root, `replay-${identity}`, `${row.query_key}.json`);
    writeChainArtifact(path, row.query_key !== options.changedRetainedRow ? row
      : { ...row, native_elapsed_ms: (row.native_elapsed_ms ?? 0) + 1 });
    if (row.query_key !== options.omitReservation) {
      writeChainArtifact(`${path}.reserved`, { replay_identity: row.query_key === options.changedReservation ? "0".repeat(64) : identity,
        query_key: row.query_key });
    }
  }
  const path = join(root, `replay-${identity}.json`);
  writeChainArtifact(path, { contract: "source-semantic-chain-replay-v3", identity,
    plan_identity: options.planIdentity ?? chainIdentity(plan), arm: "retained", provider_calls: 0, rows });
  return path;
}

async function prepareAnotherCachedQuestion(fixture: Fixture, root: string): Promise<SemanticChainPlan> {
  const config = fixture.plan.config, cacheRoot = join(root, "query-cache");
  const workset = { ...config.query_workset, items: config.query_workset.items.slice(1, 2) };
  if (!isExtractionRequestProfile(workset.request_profile)) throw new Error("supported fixture request profile required");
  const authority = pinSemanticProposalAuthority({ preflight: prepareSemanticProposal(workset, cacheRoot, config.max_output_tokens),
    inputUsdPerMillion: 1, outputUsdPerMillion: 2 });
  const fill = await executeSemanticProposalFill({ workset, cacheRoot, authority,
    config: { providerUrl: "http://127.0.0.1:9", model: workset.model, requestProfile: workset.request_profile, apiKey: "fixture" },
    extractor: { extract: async () => ({ rawJson: fixture.queryRawJson, responseMetadata: { finishReason: "STOP" },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }) } });
  expect(fill.newly_admitted).toBe(1);
  return prepareSemanticChain({ ...config, query_workset: workset, query_cache_root: cacheRoot }, root);
}

function assertGlobalArchiveMismatches(fixture: Fixture, root: string, original: Archive,
  measure: (root: string, path: string, plan: SemanticChainPlan) => unknown): void {
  for (const [name, options, reason] of [
    ["changed-plan-identity", { planIdentity: "0".repeat(64) }, /does not bind this plan/u],
    ["changed-cache-identity", { identity: "0".repeat(64) }, /semantic-correspondence state changed/u]
  ] as const) {
    const destination = join(root, name), path = retainArchive(destination, fixture.plan, original.rows, options);
    expect(() => measure(destination, path, fixture.plan)).toThrow(reason);
  }
  const semanticsRoot = join(root, "changed-admitted-query-semantics");
  const plan = { ...fixture.plan, queries: fixture.plan.queries.map((query) => query.status !== "ready" ? query
    : { ...query, query_semantics: { ...query.query_semantics, return_variables: [] } }) };
  const path = retainArchive(semanticsRoot, plan, original.rows);
  expect(() => measure(semanticsRoot, path, plan)).toThrow(/prepared query semantics changed/u);
}
