import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); vi.restoreAllMocks(); });
afterAll(() => { isolation.restore(); });
import { buildSourceReferenceCatalog, sourceReferenceResolver, sourceGoldRootIdentity, sourceSemanticInterpretationIdentity, sourceSemanticQueryIdentity,
  SourceSemanticResourceExhausted, type SourceSemanticInterpretation } from "@do-soul/alaya-protocol";
import { admitSourceSemanticCorrespondence, createAuditedSourceAdmission, createSourceSemanticInterpretationPublication, EvidenceService,
  encodeSourceSemanticLibraryResponse, fieldContractSha256, sourceSemanticLibrarySourceEntry,
  type SourceSemanticLibraryPackage } from "@do-soul/alaya-core";
import { SqliteFieldSourceRecordRepo, SqliteEventLogRepo, SqliteEvidenceCapsuleRepo } from "@do-soul/alaya-storage";
import { createDaemonFieldRepos } from "../../../runtime/field/field-repos.js";
import { createSqliteFieldFormationStores } from "../../../runtime/field/sqlite-field-formation-stores.js";
import { createRecallReadWorkerRuntime } from "../../../runtime/recall-read-worker/runtime.js";
import { runSourceSemanticLibraryRecall } from "../../../runtime/recall-read-worker/source-semantic-library-recall.js";
import { createRecallRealStorage, REAL_SQLITE_TEST_WORKSPACE_ID as WS, REAL_SQLITE_TEST_RUN_ID as RUN }
  from "../../../../../../packages/core/src/__tests__/shared/real-sqlite.test-support.js";
import { deliveredProofFixture, CLOCK } from "../../../../../../packages/core/src/__tests__/recall/runtime/source-semantic-proof-fixture.js";
import { complementaryProofSelectionFixture, deploymentStatement, selectionExecutionBudget,
  type SelectionTaskFixture } from "../../../../../../packages/core/src/__tests__/recall/runtime/source-semantic-selection-fixture.js";
import { SourceSemanticReadBudget } from "../../../runtime/field/source-semantic-read-stores.js";
import { prepareLibraryPackages, type LibraryExecutedSupport } from "../../../runtime/recall-read-worker/source-semantic-library-packages.js";
import { nativeSubsetContext, type NativeSubsetContext }
  from "./source-semantic-library-subset-packing.test-support.js";

import { accessQuery } from "./source-semantic-access.test-support.js";

const PREFIX = "序文🙂\n".repeat(600), GAP = "\n未解釈の文🙂\n", SUFFIX = "\nsource epilogue";

/** Move independently executed branches onto one Unicode source; expected windows are authored below. */
function locatedFixture(prefix = PREFIX, gap = GAP, suffix = SUFFIX) {
  const original = complementaryProofSelectionFixture(), first = original.fixture.sources[0]!;
  const statements = [deploymentStatement(1), deploymentStatement(2), deploymentStatement(3)].map(text => `${text} 注🙂`);
  const body = prefix + statements.join(gap) + suffix;
  const digest = fieldContractSha256(body), catalog = buildSourceReferenceCatalog(digest,
    statements.map((text, index) => ({ assertion_id: index + 1, text })), fieldContractSha256);
  const resolver = sourceReferenceResolver(catalog, fieldContractSha256);
  const offsets = statements.map((_, index) => Buffer.byteLength(prefix + statements.slice(0, index).join(gap)
    + (index > 0 ? gap : "")));
  const branches = original.branches.slice(0, 3).map(branch => {
    const previous = branch.proof.interpretation;
    const interpretation: SourceSemanticInterpretation = { ...previous,
      source: { ...previous.source, content_digest: `sha256:${digest}`, assertion_locations: statements.map((text, index) => ({
        assertion_id: index + 1, source_utf8_span: [offsets[index]!, offsets[index]! + Buffer.byteLength(text)] })) },
      mentions: previous.mentions.map(mention => {
        const old = previous.source.assertion_locations!.find(row => row.assertion_id === mention.assertion_id)!;
        const relative = [mention.utf8_span[0] - old.source_utf8_span[0], mention.utf8_span[1] - old.source_utf8_span[0]] as const;
        return { ...mention, source_ref: resolver.referenceForSpan(mention.assertion_id, relative),
          utf8_span: [offsets[mention.assertion_id - 1]! + relative[0], offsets[mention.assertion_id - 1]! + relative[1]] as const };
      }) };
    const fixture = deliveredProofFixture({ interpretation, semantics: original.fixture.semantics,
      correspondence: { ...branch.proof.semantic_correspondence,
        source_interpretation_id: sourceSemanticInterpretationIdentity(interpretation, fieldContractSha256) },
      original: original.fixture.original, library: true, budget: selectionExecutionBudget });
    const group = { ...branch.group, entry: fixture.entry, entries: fixture.index.entries,
      explanations: fixture.index.explanations ?? [], proofs: [fixture.proof] };
    return { proof: fixture.proof, group, source: body, dependencies: fixture.source_dependencies };
  });
  const fixture: SelectionTaskFixture = { ...original.fixture,
    sources: [{ ...first, body, package: branches[0]!.group }, original.fixture.sources[1]!],
    pool: [...branches.map(row => row.group), original.fixture.sources[1]!.package] };
  return { fixture, branches, body, statements, offsets };
}

function prepare(context: NativeSubsetContext, branches: readonly LibraryExecutedSupport[],
  meter = new SourceSemanticReadBudget(selectionExecutionBudget), scopes = ["project"]) {
  const sources = context.fixture.sources.map(source => {
    const target = source.package.entry.target;
    if (target.kind !== "source_evidence") throw new Error("source root expected");
    return sourceSemanticLibrarySourceEntry({ workspaceId: target.workspace_id, root_id: target.root_id,
      source_version: target.source_version, content_digest: target.content_digest,
      evidence_object_id: target.evidence_object_id, hypothesis_id: "admitted-source-hypothesis" });
  });
  return prepareLibraryPackages(context.runtime, { workspace_id: "ws", as_of: CLOCK,
    authorized_scopes: { mode: "named", scopes: ["project"] } } as never, scopes, meter, sources, branches);
}
function located(rows: readonly SourceSemanticLibraryPackage[]) {
  return rows.filter(row => row.proofs.length === 0 && row.entry.target.kind === "source_evidence"
    && row.entry.target.span!.content_start > 0);
}

it("adds one exact non-prefix Unicode window for a single executed branch, without borrowing proof qualification", async () => {
  const authored = locatedFixture(), context = await nativeSubsetContext(authored.fixture);
  try {
    const result = prepare(context, authored.branches.slice(0, 1));
    expect(result.incomplete).toBe(false);
    expect(located(result.packages)).toHaveLength(1);
    const window = located(result.packages)[0]!;
    expect(window.preview).toBe(authored.statements[0]);
    expect(window.entry.target).toMatchObject({ span: { content_start: Buffer.byteLength(PREFIX),
      content_end: Buffer.byteLength(PREFIX + authored.statements[0]), content_complete: false, original_complete: false } });
    expect(Buffer.from(authored.body).subarray(authored.offsets[0], authored.offsets[0]! + Buffer.byteLength(window.preview)))
      .toEqual(Buffer.from(window.preview));
    expect(window).toMatchObject({ entries: [window.entry], explanations: [], proofs: [], payload_support: "envelope_budget" });
    expect(window.entry).toMatchObject({ hypothesis_id: "admitted-source-hypothesis", claim: "unknown", explanation_ids: [] });
    expect(window.entry).not.toHaveProperty("interpretation_node");
    expect(window.entry.target).not.toHaveProperty("interpretation_node");
    expect(window.source_disclosure.proof_use).toEqual({ kind: "source_only", qualification: "not_current_proof" });
    const proof = result.packages.find(row => row.proofs.length === 1)!;
    expect(sourceGoldRootIdentity(window.entry.target as never)).toBe(sourceGoldRootIdentity(proof.entry.target as never));
    expect(result.packages.filter(row => row.proofs.length === 0 && !located([row]).length)).toHaveLength(2);
    const prefix = new SqliteFieldSourceRecordRepo(context.runtime.database, fieldContractSha256)
      .findByIdBounded("ws", authored.branches[0]!.proof.source_record.identity, 4096, 0)!;
    expect(prefix.bodyBytes).toBe(Buffer.byteLength(authored.body));
    expect(Buffer.byteLength(prefix.record!.source_body!)).toBeLessThanOrEqual(4096);
    expect(prefix.record!.source_body).not.toContain(authored.statements[0]);
  } finally { await context.close(); }
});

it("offers only the complete exact hull across branches and leaves interstitial text unknown", async () => {
  const authored = locatedFixture(), context = await nativeSubsetContext(authored.fixture);
  try {
    const result = prepare(context, authored.branches);
    expect(result.incomplete).toBe(false); expect(located(result.packages)).toHaveLength(1);
    const window = located(result.packages)[0]!;
    expect(window.preview).toBe(authored.statements.join(GAP));
    expect(window.entry.target).toMatchObject({ span: { content_start: Buffer.byteLength(PREFIX),
      content_end: Buffer.byteLength(PREFIX + authored.statements.join(GAP)), content_complete: false } });
    expect(result.packages.filter(row => row.proofs.length > 0).map(row => row.proofs.length)).toEqual([3, 1, 1, 1]);
    expect(window.entry.claim).toBe("unknown"); expect(window.proofs).toEqual([]);
  } finally { await context.close(); }
});

it.each(["no_branches", "no_dependencies", "unknown_dependency", "missing_location", "whole_source"] as const)(
  "does not turn %s into a located source-only alternative", async condition => {
    const authored = locatedFixture(condition === "whole_source" ? "先頭🙂\n" : PREFIX), context = await nativeSubsetContext(authored.fixture);
    try {
      let branches: readonly LibraryExecutedSupport[] = authored.branches.slice(0, 1);
      if (condition === "no_branches") branches = [];
      if (condition === "no_dependencies") branches = [{ ...branches[0]!, dependencies: [] }];
      if (condition === "unknown_dependency") branches = [{ ...branches[0]!, dependencies: ["absent-node"] }];
      if (condition === "missing_location" || condition === "whole_source") branches = [{ ...branches[0]!, proof: {
        ...branches[0]!.proof, interpretation: { ...branches[0]!.proof.interpretation,
          source: { ...branches[0]!.proof.interpretation.source, assertion_locations: [] } } } }];
      const result = prepare(context, branches);
      expect(result.incomplete).toBe(false); expect(located(result.packages)).toEqual([]);
      expect(result.packages.filter(row => row.proofs.length === 0)).toHaveLength(2);
      if (condition === "whole_source") expect(result.packages.some(row => row.proofs.length === 1)).toBe(true);
      if (condition === "missing_location") expect(result.packages[0]!.payload_support).toBe("location_missing");
    } finally { await context.close(); }
  });

it("rejects an over-cap hull even when each independently executed branch fits", async () => {
  const authored = locatedFixture(PREFIX, "\n" + "間".repeat(1500) + "\n"), context = await nativeSubsetContext(authored.fixture);
  try {
    const result = prepare(context, authored.branches.slice(0, 2));
    expect(result.incomplete).toBe(false); expect(located(result.packages)).toEqual([]);
    expect(result.packages.filter(row => row.proofs.length > 0).map(row => row.proofs.length)).toEqual([1, 1]);
  } finally { await context.close(); }
});

it("delivers the produced non-prefix Unicode window through native publication, recall and public encoding with unchanged O1", async () => {
  const authored = locatedFixture(), branch = authored.branches[0]!, interpretation = branch.proof.interpretation;
  const original = "Was permission granted?", semantics = accessQuery(original, "permission granted");
  const catalog = buildSourceReferenceCatalog(fieldContractSha256(authored.body), authored.statements.map((text, index) => ({
    assertion_id: index + 1, text })), fieldContractSha256);
  // Catalog selection uses local UTF-16 offsets; delivered source spans below use UTF-8 bytes.
  const sourceRef = sourceReferenceResolver(catalog, fieldContractSha256).referenceForSpan(1, [0, authored.statements[0]!.length]);
  const { database } = await createRecallRealStorage(() => undefined);
  try {
    const eventLogRepo = new SqliteEventLogRepo(database), runtimeNotifier = { notifyEntry: async () => undefined };
    const stores = createSqliteFieldFormationStores({ database, repos: createDaemonFieldRepos({ database }) });
    const admission = createAuditedSourceAdmission({ stores, eventLogRepo, runtimeNotifier, sha256: fieldContractSha256 });
    await admission.admit({ workspace_id: WS, source_id: interpretation.source.source_id, source_version: "1",
      content_bytes: authored.body, evidence_object_id: null, recorded_at: CLOCK, event_time: null,
      valid_from: null, valid_to: null, speaker: null, scope_class: "project", spans: [] }, { workspaceId: WS });
    const evidenceService = new EvidenceService({ eventLogRepo, runtimeNotifier,
      evidenceCapsuleRepo: new SqliteEvidenceCapsuleRepo(database), now: () => CLOCK });
    const published = await createSourceSemanticInterpretationPublication({ stores, evidenceService, sha256: fieldContractSha256 }).publish({
      workspaceId: WS, runId: RUN, artifactKey: interpretation.source.source_id, source: authored.body,
      attribution_context: interpretation.source.attribution_context, budget: selectionExecutionBudget,
      catalog, assertion_locations: interpretation.source.assertion_locations!, provenance: { producer_id: "located-source-author" },
      producer_version: "1", contract_version: "source-interpretation-v4",
      draft: { contract: "source-interpretation-v4", mentions: [{ id: "mStatement", assertion_id: 1, source_ref: sourceRef }],
        referents: [], frames: [{ id: "fStatement", assertion_ids: [1],
          context_owner: { kind: "source_act", source_act: "assertion" }, additional_support: [],
          predicate_support: { kind: "explicit", reading: "permission granted", mentions: ["mStatement"] }, slots: [], bindings: [] }],
        operators: [], gaps: [] } });
    expect(published.bound.interpretation.gaps).toHaveLength(2);
    const aligned = admitSourceSemanticCorrespondence({ source_interpretation: published.bound.interpretation,
      query_semantics: semantics, original_query: original,
      semantic_correspondence: { ...branch.proof.semantic_correspondence, source_interpretation_id: published.bound.interpretation_id,
        query_semantics_id: sourceSemanticQueryIdentity(semantics, fieldContractSha256), correspondences: [{ relation: "contextual_equivalence",
          query_endpoint: { kind: "predicate", alternative: 0, frame: "qStatement" }, source_endpoint: { kind: "frame", frame: "fStatement" },
          query_support: { kind: "query_text", excerpt: "permission granted" }, source_semantic_support: [{ kind: "lexical", mentions: ["mStatement"] }] }] } });
    expect(aligned.kind).toBe("admitted");
    if (aligned.kind !== "admitted") throw new Error("published source correspondence must admit");
    const request = { kind: "recall" as const, accepts_unreviewed_conditional_results: true as const,
      original_query: original, query_semantics: semantics,
      semantic_correspondences: [aligned.semantic_correspondence],
      budget: selectionExecutionBudget, output_byte_limit: 11_000 };
    const call = (scopes = ["project"]) => runSourceSemanticLibraryRecall(createRecallReadWorkerRuntime(database), {
      workspace_id: WS, as_of: CLOCK, authorized_scopes: { mode: "named", scopes }, request
    }, scopes, new SourceSemanticReadBudget(selectionExecutionBudget));
    const native = call();
    if (native.kind !== "recall") throw new Error("native recall expected");
    const encoded = encodeSourceSemanticLibraryResponse(native);
    if (encoded.operation !== "recall") throw new Error("public recall expected");
    expect(native.discovery.examined_source_interpretation_ids).toEqual([published.bound.interpretation_id]);
    expect(native.proofs ?? []).toEqual([]); expect(native.index.entries).toHaveLength(1);
    expect(native.index.entries[0]!.target).toMatchObject({ span: { content_start: Buffer.byteLength(PREFIX),
      content_end: Buffer.byteLength(PREFIX + authored.statements[0]), content_complete: false, original_complete: false } });
    expect(native.slot_qualifiers).toEqual([{ index: 0, evidence_kind: "source_evidence", payload_support: "envelope_budget",
      selection_basis: "source_access" }]);
    expect(encoded.results?.[0]?.content_preview).toBe(authored.statements[0]);
    expect(encoded.results?.[0]?.budget_state.within_budget).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(encoded))).toBeLessThanOrEqual(request.output_byte_limit);
    const denied = call(["global_core"]);
    if (denied.kind !== "recall") throw new Error("native recall expected");
    expect(denied.index.entries).toEqual([]);
    await admission.admit({ workspace_id: WS, source_id: interpretation.source.source_id, source_version: "2",
      content_bytes: "current replacement", evidence_object_id: null, recorded_at: "2026-09-19T00:00:00.000Z", event_time: null,
      valid_from: null, valid_to: null, speaker: null, scope_class: "project", spans: [] }, { workspaceId: WS });
    const changed = call();
    if (changed.kind !== "recall") throw new Error("native recall expected");
    expect(changed.proofs ?? []).toEqual([]);
    expect(changed.index.entries).toHaveLength(1);
    expect(changed.index.entries[0]!.target).toMatchObject({ source_version: "2", span: { content_start: 0 } });
  } finally { database.close(); }
});

class WindowBudget extends SourceSemanticReadBudget {
  readonly charges: { phase: string; work: number; bytes: number }[] = [];
  rejected: string | undefined;
  override charge(work: number, bytes: number, phase = "preparation"): void {
    this.charges.push({ phase, work: this.spentWork, bytes: this.spentBytes });
    super.charge(work, bytes, phase);
  }
  override reserve(work: number, bytes: number, phase = "preparation"): void {
    try { super.reserve(work, bytes, phase); }
    catch (error) {
      if (error instanceof SourceSemanticResourceExhausted) this.rejected = phase;
      throw error;
    }
  }
}

it.each(["work_units", "memory_bytes"] as const)("preserves every root's baselines when optional %s is refused", async resource => {
  const authored = locatedFixture(), context = await nativeSubsetContext(authored.fixture);
  try {
    const later = authored.fixture.sources[1]!;
    const branches = [...authored.branches, { proof: later.package.proofs[0]!, group: later.package,
      source: later.body, dependencies: later.dependencies }];
    const measured = new WindowBudget(selectionExecutionBudget), full = prepare(context, branches, measured);
    expect(full.incomplete).toBe(false);
    expect(full.packages.map(row => row.proofs.length)).toEqual([3, 1, 1, 1, 0, 1, 0, 0, 0]);
    // Four singleton hydrations, one union and two raw prefixes: no optional full-source hydration.
    expect(measured.charges.filter(row => row.phase === "library source window encoding")).toHaveLength(7);
    for (const phase of ["library source-only candidates", "library source-only insertion"]) {
      const before = measured.charges.find(row => row.phase === phase)!;
      const cap = resource === "work_units" ? before.work : before.bytes;
      const bounded = new WindowBudget({ ...selectionExecutionBudget, [resource]: cap });
      const actual = prepare(context, branches, bounded);
      expect(actual.incomplete).toBe(true); expect(bounded.rejected).toBe(phase);
      expect(actual.packages).toEqual(full.packages.slice(0, -2));
      expect(actual.packages.some(row => row.access_position === 1 && row.proofs.length === 1)).toBe(true);
      expect(actual.packages.some(row => row.access_position === 1 && row.proofs.length === 0)).toBe(true);
      expect(resource === "work_units" ? bounded.spentWork : bounded.spentBytes).toBeLessThanOrEqual(cap);
    }
  } finally { await context.close(); }
});

it("does not offer a located alternative after branch enumeration is interrupted", async () => {
  const authored = locatedFixture(), context = await nativeSubsetContext(authored.fixture);
  try {
    const measured = new WindowBudget(selectionExecutionBudget);
    prepare(context, authored.branches, measured);
    const second = measured.charges.filter(row => row.phase === "source support byte extent")[1]!;
    const bounded = new WindowBudget({ ...selectionExecutionBudget, work_units: second.work });
    const actual = prepare(context, authored.branches, bounded);
    expect(actual.incomplete).toBe(true); expect(located(actual.packages)).toEqual([]);
    expect(actual.packages.filter(row => row.proofs.length === 1)).toHaveLength(1);
  } finally { await context.close(); }
});

it("marks content complete only for an exact hull covering the known full current body", async () => {
  const authored = locatedFixture("", GAP, ""), context = await nativeSubsetContext(authored.fixture);
  try {
    const result = prepare(context, authored.branches);
    expect(result.incomplete).toBe(false);
    const window = result.packages.at(-1)!;
    expect(window.proofs).toEqual([]); expect(window.preview).toBe(authored.body);
    expect(window.entry.target).toMatchObject({ span: { content_start: 0, content_end: Buffer.byteLength(authored.body),
      content_complete: true, original_complete: false } });
    const single = prepare(context, authored.branches.slice(0, 1)).packages.at(-1)!;
    expect(single.entry.target).toMatchObject({ span: { content_start: 0, content_complete: false } });
    expect(prepare(context, authored.branches, undefined, ["global_core"])).toEqual({ packages: [], incomplete: true });
  } finally { await context.close(); }
});

it("does not add a partial hull when any other executed branch lacks locations", async () => {
  const authored = locatedFixture(), context = await nativeSubsetContext(authored.fixture);
  try {
    const branches = [authored.branches[0]!, { ...authored.branches[1]!, dependencies: [] }];
    const result = prepare(context, branches);
    expect(result.incomplete).toBe(false); expect(located(result.packages)).toEqual([]);
    expect(result.packages.filter(row => row.proofs.length > 0)).toHaveLength(1);
  } finally { await context.close(); }
});
