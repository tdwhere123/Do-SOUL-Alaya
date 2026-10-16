import { execFileSync } from "node:child_process";
import { sourceDisclosure } from "@do-soul/alaya-protocol";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); });
afterAll(() => { isolation.restore(); });
import { canonicalJson } from "@do-soul/alaya-protocol";
import { encodeSourceSemanticLibraryResponse, fieldContractSha256, selectSourceSemanticLibraryPage,
  type SourceSemanticLibraryPackage } from "@do-soul/alaya-core";
import { alternativeSelectionFixture, complementaryProofSelectionFixture, coverageSelectionFixture,
  physicalRoot, previewNoveltySelectionFixture, rawSourceTwin, selectionExecutionBudget, textWindowSelectionFixture,
  type SelectionTaskFixture } from "../../../../../../packages/core/src/__tests__/recall/runtime/source-semantic-selection-fixture.js";
import { SourceSemanticReadBudget } from "../../../runtime/field/source-semantic-read-stores.js";
import { prepareLibraryPackages, prepareLibraryPackagePairs, type LibraryExecutedSupport } from "../../../runtime/recall-read-worker/source-semantic-library-packages.js";
import type { LibraryPageSelector } from "../../../runtime/recall-read-worker/source-semantic-library-delivery.js";
import { deliverAllPages, measureNativeSubset, nativeSubsetContext, persistArtifact, roomyDeliveryBytes,
  type NativeSubsetContext } from "./source-semantic-library-subset-packing.test-support.js";
import { freezeTextGold, measureTextRecall, textRecallPolicies } from "./source-semantic-library-text-recall.test-support.js";

const wrappedDefault: LibraryPageSelector = input => selectSourceSemanticLibraryPage(input);
const defaultBranches = (fixture: SelectionTaskFixture) => fixture.sources.map(source => ({ proof: source.package.proofs[0]!,
  group: source.package, source: source.body, dependencies: source.dependencies }));

function windows(context: NativeSubsetContext, branches: readonly LibraryExecutedSupport[] = defaultBranches(context.fixture)) {
  const result = prepareLibraryPackages(context.runtime,
    { workspace_id: "ws", as_of: "2026-09-18T00:00:00.000Z", authorized_scopes: { mode: "named", scopes: ["project"] } } as never,
    ["project"], new SourceSemanticReadBudget(selectionExecutionBudget), context.fixture.sources.map(row => rawSourceTwin(row.package).entry), branches);
  expect(result.incomplete).toBe(false);
  return result.packages;
}

function observe(context: NativeSubsetContext, candidates: readonly SourceSemanticLibraryPackage[], limit: number, wrapped: boolean) {
  // The wrapper is the deliberately narrower historical control, never the native arm.
  let wrapperWork = 0, wrapperBytes = 0;
  const control: LibraryPageSelector = input => {
    const work = input.meter.spentWork, bytes = input.meter.spentBytes;
    const result = wrappedDefault(input);
    wrapperWork += input.meter.spentWork - work; wrapperBytes += input.meter.spentBytes - bytes;
    return result;
  };
  const run = measureNativeSubset(context, limit, undefined, candidates, wrapped ? control : selectSourceSemanticLibraryPage);
  const delivery_work: typeof run.delivery_work[] = [];
  const nativePages = deliverAllPages(context, run, (_page, cost) => delivery_work.push(cost));
  expect(nativePages[0]).toBe(run.native);
  expect(delivery_work[0]).toEqual(run.delivery_work);
  expect(delivery_work).toHaveLength(run.plan.pages.length);
  if (wrapped) expect(run.selector_work).toEqual({ logical_work: wrapperWork, logical_bytes: wrapperBytes });
  const publicPages = nativePages.map(page => {
    const encoded = encodeSourceSemanticLibraryResponse(page);
    if (encoded.operation !== "recall") throw new Error("public recall page expected");
    expect(Buffer.byteLength(JSON.stringify(encoded))).toBeLessThanOrEqual(limit);
    expect(encoded.results?.every(row => row.budget_state.within_budget)).toBe(true);
    // RSS and fresh continuation capabilities are process-local telemetry/authority,
    // not selector output. Keep all bound cursor, revision, scope and byte fields.
    const index = encoded.index, continuation = index?.continuation;
    return { ...encoded, work: { ...encoded.work, rss_bytes: 0 }, index: index === undefined ? index : {
      ...index, continuation: continuation == null ? continuation : { ...continuation,
        continuation_id: "fresh-continuation", capability: "fresh-capability" }
    } };
  });
  return { run, publicPages, summary: { selector_work: run.selector_work, selector_regions: run.selector_regions,
    preparation_work: run.preparation_work, preparation_phases: run.preparation_phases, budget_rejections: run.budget_rejections,
    first_page_delivery_work: run.delivery_work, delivery_work,
    pages: nativePages.map((page, index) => ({ encoded_bytes: Buffer.byteLength(JSON.stringify(encodeSourceSemanticLibraryResponse(page))),
      public_sha256_excluding_rss_and_fresh_capabilities: fieldContractSha256(canonicalJson(publicPages[index])), index: page.index,
      proofs: (page.proofs ?? []).map(proof => ({ id: proof.conditional_computation_id, sha256: fieldContractSha256(canonicalJson(proof)) })),
      previews: page.previews, qualifiers: page.slot_qualifiers, coverage: page.coverage, discovery: page.discovery,
      exposure: run.exposure_pages[index] })),
    truncated: run.plan.discovery.truncated } };
}

function compare(context: NativeSubsetContext, candidates: readonly SourceSemanticLibraryPackage[], limit: number, equalPages = true) {
  const native = observe(context, candidates, limit, false), wrapped = observe(context, candidates, limit, true);
  expect(native.run.request).toEqual(wrapped.run.request);
  expect(native.run.plan.pages.map(page => page.map(physicalRoot))).toEqual(wrapped.run.plan.pages.map(page => page.map(physicalRoot)));
  expect(native.run.plan.page_access).toEqual(wrapped.run.plan.page_access);
  const equal = canonicalJson(native.publicPages) === canonicalJson(wrapped.publicPages);
  expect(equal).toBe(equalPages);
  if (equalPages) {
    expect(native.run.plan).toEqual(wrapped.run.plan);
    expect(native.summary.pages.map(page => page.encoded_bytes)).toEqual(wrapped.summary.pages.map(page => page.encoded_bytes));
    expect(native.summary.delivery_work).toEqual(wrapped.summary.delivery_work);
  }
  expect(native.run.selector_regions.some(row => row.region === "same_root_post_pass")).toBe(true);
  expect(wrapped.run.selector_regions.some(row => row.region === "same_root_post_pass")).toBe(false);
  const phases = Object.values(native.run.preparation_phases);
  expect(phases.reduce((sum, row) => sum + row.logical_work, 0)).toBe(native.run.preparation_work.logical_work);
  expect(phases.reduce((sum, row) => sum + row.logical_bytes, 0)).toBe(native.run.preparation_work.logical_bytes);
  return { native, wrapped, receipt: { limit, equal_public_pages_excluding_rss_and_fresh_capabilities: equal,
    native_default: native.summary, wrapped_default_without_same_root_post_pass: wrapped.summary } };
}

const firstRoot = (fixture: SelectionTaskFixture): SelectionTaskFixture => ({ ...fixture,
  sources: fixture.sources.slice(0, 1), pool: fixture.pool.filter(row => physicalRoot(row) === physicalRoot(fixture.pool[0]!)) });

it.each([false, true])("observes the unwrapped post-pass without inventing pairs for a root with proof: %s", async proof => {
  const context = await nativeSubsetContext(firstRoot(textWindowSelectionFixture(false)));
  try {
    const prepared = windows(context), candidates = proof ? prepared : prepared.filter(row => row.proofs.length === 0);
    const pair = compare(context, candidates, roomyDeliveryBytes);
    expect(pair.native.run.native.proofs?.length ?? 0).toBe(proof ? 1 : 0);
    expect(pair.native.run.preparation_phases["library pair source search"]?.logical_work).toBe(candidates.length);
    expect(pair.native.run.preparation_phases["library proof pair enumeration"]).toBeUndefined();
    await persistArtifact(proof ? "single-proof" : "no-proof", "paired.json", { candidates, ...pair.receipt });
  } finally { await context.close(); }
});

it("measures a real same-root improvement over three complementary independent proofs", async () => {
  const authored = complementaryProofSelectionFixture(), context = await nativeSubsetContext(firstRoot(authored.fixture));
  try {
    const branches = authored.branches.slice(0, 3), candidates = windows(context, branches);
    expect(new Set(branches.map(row => row.proof.source_interpretation_id)).size).toBe(3);
    expect(candidates.map(row => row.proofs.length)).toEqual([3, 1, 1, 1, 0, 0]);
    const admitted = rawSourceTwin(context.fixture.sources[0]!.package).entry, union = candidates[0]!, hull = candidates.at(-1)!;
    if (admitted.target.kind !== "source_evidence") throw new Error("admitted source tuple expected");
    expect(union.proofs).toHaveLength(3);
    expect(hull.proofs).toEqual([]);
    expect(hull.entries).toEqual([hull.entry]);
    expect(hull.explanations).toEqual([]);
    expect(hull.entry.target).toMatchObject({ kind: "source_evidence",
      span: { content_start: 0, content_end: Buffer.byteLength(authored.fixture.sources[0]!.body) } });
    expect(hull.entry).toMatchObject({ hypothesis_id: admitted.hypothesis_id, claim: "unknown", explanation_ids: [] });
    expect(hull.entry.hypothesis_id).not.toBe(union.entry.hypothesis_id);
    expect(hull.entry).not.toHaveProperty("interpretation_node");
    expect(hull.entry.target).not.toHaveProperty("interpretation_node");
    expect(hull.entry.target).toMatchObject({ workspace_id: admitted.target.workspace_id, root_id: admitted.target.root_id,
      source_version: admitted.target.source_version, content_digest: admitted.target.content_digest,
      evidence_object_id: admitted.target.evidence_object_id });
    expect(sourceDisclosure(hull.source_disclosure).proof_use).toEqual({ kind: "source_only", qualification: "not_current_proof" });
    const [two] = [...prepareLibraryPackagePairs(candidates, [candidates.find(row => row.proofs.length === 1)!],
      new SourceSemanticReadBudget(selectionExecutionBudget))];
    expect(two).toBeDefined();
    const limit = measureNativeSubset(context, roomyDeliveryBytes, [two!], [two!]).reserved_bytes!;
    const pair = compare(context, candidates, limit, false);
    expect(pair.wrapped.run.native.proofs).toHaveLength(1);
    expect(pair.native.run.native.proofs).toHaveLength(2);
    expect(pair.native.run.preparation_phases["library proof pair enumeration"]!.logical_work).toBeGreaterThan(0);
    expect(pair.native.run.native.proofs!.every(proof => branches.some(row => canonicalJson(row.proof) === canonicalJson(proof)))).toBe(true);
    // The existing text evaluator must exercise the identical native path, too.
    const text = measureTextRecall(context, candidates, limit, selectSourceSemanticLibraryPage, freezeTextGold(context.fixture));
    expect(text.retained_proof_claims).toHaveLength(2);
    expect(text.selector_work).toBe(pair.native.run.selector_work.logical_work);
    expect(text.delivery_work).toHaveLength(1);
    for (const selector of [textRecallPolicies.anytime_pairs, textRecallPolicies.deferred_new_text]) {
      const privateRun = measureNativeSubset(context, limit, undefined, candidates, selector);
      expect(privateRun.selector_regions.some(row => row.region === "same_root_post_pass")).toBe(false);
      expect(privateRun.preparation_phases["library pair source search"]).toBeUndefined();
    }
    await persistArtifact("complementary-proofs", "paired.json", { candidates, ...pair.receipt });
  } finally { await context.close(); }
});

it("preserves a shared interpretation structure without treating its uses as independent proof alternatives", async () => {
  const authored = firstRoot(coverageSelectionFixture(selectionExecutionBudget));
  const inputProof = authored.sources[0]!.package.proofs[0]!;
  const interpretation = inputProof.interpretation;
  const expectedProof = canonicalJson(inputProof), expectedInterpretation = canonicalJson(interpretation);
  const shared = interpretation.frames.flatMap(row => row.bindings.map(binding => binding.target));
  expect(shared.length).toBeGreaterThanOrEqual(3);
  expect(new Set(shared.map(target => canonicalJson(target))).size).toBe(1);
  expect(interpretation.referents).toHaveLength(1);
  const context = await nativeSubsetContext(authored);
  try {
    const candidates = windows(context), pair = compare(context, candidates, roomyDeliveryBytes);
    const delivered = pair.native.run.native.proofs ?? [];
    expect(delivered).toHaveLength(1);
    expect(canonicalJson(delivered[0])).toBe(expectedProof);
    expect(canonicalJson(delivered[0]!.interpretation)).toBe(expectedInterpretation);
    expect(pair.native.run.preparation_phases["library proof pair enumeration"]).toBeUndefined();
    await persistArtifact("shared-subgraph", "paired.json", { candidates, ...pair.receipt });
  } finally { await context.close(); }
});

it.each([roomyDeliveryBytes, 51_708])("compares every long-tail delivery page at the fixed %i-byte limit", async limit => {
  const context = await nativeSubsetContext(textWindowSelectionFixture(true));
  try {
    const candidates = windows(context), pair = compare(context, candidates, limit);
    expect(candidates.some(row => row.entry.target.kind === "source_evidence" && (row.entry.target.span?.content_start ?? 0) > 4096)).toBe(true);
    expect(pair.native.run.plan.pages).toHaveLength(limit === 51_708 ? 5 : 1);
    await persistArtifact(`long-tail-${limit}`, "paired.json", { candidates, ...pair.receipt });
  } finally { await context.close(); }
}, 120_000);

// Retained limits are required for this optional historical-pool comparison;
// deriving new size clusters would change the frozen experiment.
const frozen = process.env["ALAYA_SELECTION_FROZEN_LIMITS_DIR"];
const enabled = process.env["ALAYA_SELECTION_POLICY_SCAN"] === "1";
const measurementSources = [
  "apps/core-daemon/src/__tests__/runtime/recall/source-semantic-library-default-measurement.test.ts",
  "apps/core-daemon/src/__tests__/runtime/recall/source-semantic-library-selection-gap.test-support.ts",
  "apps/core-daemon/src/__tests__/runtime/recall/source-semantic-library-subset-packing.test-support.ts",
  "apps/core-daemon/src/__tests__/runtime/recall/source-semantic-library-exposure.test-support.ts",
  "apps/core-daemon/src/__tests__/runtime/recall/source-semantic-library-text-recall.test-support.ts",
  "packages/core/src/__tests__/recall/runtime/source-semantic-selection-fixture.ts"] as const;
function measurementProvenance() {
  const worktree = realpathSync(fileURLToPath(new URL("../../../../../../", import.meta.url)));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: worktree, encoding: "utf8" }).trim();
  const status = git("status", "--porcelain=v1", "--untracked-files=all");
  return { head: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}"),
    base: git("merge-base", "HEAD", "main"), dirty: status !== "", status,
    worktree: realpathSync(git("rev-parse", "--show-toplevel")),
    sources: Object.fromEntries(measurementSources.map(path => [path,
      createHash("sha256").update(readFileSync(join(worktree, path))).digest("hex")])) };
}
const pools = {
  alternatives: () => alternativeSelectionFixture(selectionExecutionBudget),
  coverage: () => coverageSelectionFixture(selectionExecutionBudget),
  raw_five: () => alternativeSelectionFixture(selectionExecutionBudget),
  long_source: () => textWindowSelectionFixture(true),
  redundant_proof: () => textWindowSelectionFixture(false),
  partial_overlap: () => previewNoveltySelectionFixture("partial_overlap"),
  repeated_lines: () => previewNoveltySelectionFixture("repeated_lines"),
  irrelevant_novel: () => previewNoveltySelectionFixture("irrelevant_novel")
};
for (const [name, make] of Object.entries(pools)) {
  it.skipIf(!enabled)(`compares the native default with every retained ${name} pool page and proof alternative`, async () => {
    if (frozen === undefined) throw new Error("retained numeric limits directory required");
    const control = ["partial_overlap", "repeated_lines", "irrelevant_novel"].includes(name);
    const receiptPath = join(control ? join(frozen, "..", "text-recall-controls") : frozen, `${name}.json`);
    const retained = JSON.parse(await readFile(receiptPath, "utf8")) as { limits: number[] };
    const context = await nativeSubsetContext(make());
    try {
      const candidates = ["alternatives", "coverage", "raw_five"].includes(name)
        ? context.fixture.pool.flatMap(row => [rawSourceTwin(row), row]) : windows(context);
      const gold = freezeTextGold(context.fixture);
      expect(candidates.every(row => row.proofs.length <= 1)).toBe(true);
      await persistArtifact("retained-pools", `${name}-inputs.json`, { ...measurementProvenance(),
        retained_limits: receiptPath, limits: retained.limits, gold, candidates,
        scope: "paired default-path alignment only; original authored gold and private policy definitions unchanged",
        cost_scope: "selector_work includes fit and same-root post-pass; preparation_work freezes all pages once; delivery_work is once per logical page with separate ledgers, not one task budget" });
      const rows = retained.limits.map(limit => {
        const pair = compare(context, candidates, limit);
        expect(pair.native.run.preparation_phases["library proof pair enumeration"]).toBeUndefined();
        return pair.receipt;
      });
      expect(rows).toHaveLength(control ? 14 : ["long_source", "redundant_proof"].includes(name) ? 12 : 24);
      await persistArtifact("retained-pools", `${name}.json`, { limits: retained.limits, rows,
        conclusion: "All delivered pages, proofs, encoded byte lengths and delivery ledgers match. Native preparation/selector ledgers additionally charge a same-root search with no eligible >2-proof union; historical numbers retain the wrapped-default-without-same-root-post-pass label." });
    } finally { await context.close(); }
  }, 600_000);
}
