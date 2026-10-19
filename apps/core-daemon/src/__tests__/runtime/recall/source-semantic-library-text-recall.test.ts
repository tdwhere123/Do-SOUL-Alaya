import { afterAll, afterEach, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); });
afterAll(() => { isolation.restore(); });
import { SourceSemanticResourceExhausted, SourceSemanticResourceLedger } from "@do-soul/alaya-protocol";
import { alternativeSelectionFixture, coverageSelectionFixture, rawSourceTwin, selectionExecutionBudget,
  textWindowSelectionFixture, previewNoveltySelectionFixture }
  from "../../../../../../packages/core/src/__tests__/recall/runtime/source-semantic-selection-fixture.js";
import { prepareLibraryPackages } from "../../../runtime/recall-read-worker/source-semantic-library-packages.js";
import { SourceSemanticReadBudget } from "../../../runtime/field/source-semantic-read-stores.js";
import { measureNativeSubset, nativeSubsetContext, persistArtifact, roomyDeliveryBytes, type NativeSubsetContext }
  from "./source-semantic-library-subset-packing.test-support.js";
import { selectionGapLimits } from "./source-semantic-library-selection-gap.test-support.js";
import { freezeTextGold, measureTextRecall, textRecallPolicies, previewNoveltyBytes, compareSourceExposure } from "./source-semantic-library-text-recall.test-support.js";

function preparedWindows(context: NativeSubsetContext) {
  const result = prepareLibraryPackages(context.runtime,
    { workspace_id: "ws", as_of: "2026-09-18T00:00:00.000Z", authorized_scopes: { mode: "named", scopes: ["project"] } } as never,
    ["project"], new SourceSemanticReadBudget(selectionExecutionBudget), context.fixture.pool.map(rawSourceTwin).map(row => row.entry),
    context.fixture.sources.map(source => ({ proof: source.package.proofs[0]!, group: source.package,
      source: source.body, dependencies: source.dependencies })));
  expect(result.incomplete).toBe(false);
  expect(result.packages.filter(row => row.proofs.length > 0)).toHaveLength(context.fixture.sources.length);
  return result.packages;
}

it.each([false, true])("freezes text gold before measuring source windows (long source: %s)", async long => {
  const context = await nativeSubsetContext(textWindowSelectionFixture(long));
  try {
    const gold = freezeTextGold(context.fixture), candidates = preparedWindows(context);
    const raw = measureTextRecall(context, candidates, roomyDeliveryBytes, textRecallPolicies.raw_only, gold);
    const semantic = measureTextRecall(context, candidates, roomyDeliveryBytes, textRecallPolicies.anytime_pairs, gold);
    expect(raw.recall_at_5).toBe(long ? 0.8 : 1);
    expect(semantic.recall_at_5).toBe(1);
    expect(semantic.retained_proof_claims).toHaveLength(5);
    for (const measured of [raw, semantic]) {
      expect(measured.exposure_pages_observed).toBe(measured.planned_pages);
      expect(measured.reserved_plan_fully_observed).toBe(true);
      expect(measured.first_page_exposure.contract).toBe("source-position-exposure-v1");
      expect(measured.first_page_exposure.position.status).toBe("complete");
      expect(measured.exposure_pages.at(-1)!.position.cumulative_known).toBe(measured.eventual_source_exposure.reduce(
        (sum, row) => sum + Buffer.byteLength(row.text === "[empty source]" ? "" : row.text), 0));
    }
    expect(compareSourceExposure(raw, { ...raw, reserved_plan_fully_observed: false })).toEqual([
      { root: null, status: "unknown", lost_bytes: null }]);
    const novel = measureTextRecall(context, candidates, roomyDeliveryBytes, textRecallPolicies.new_text_per_byte, gold);
    expect(novel.recall_at_5).toBe(1);
    expect(novel.retained_proof_claims).toHaveLength(long ? 1 : 0);
  } finally { await context.close(); }
}, 120_000);

it.each([10_000, 51_277])("retains raw exposure when a proof cannot fit the current envelope at %i bytes", async limit => {
  const context = await nativeSubsetContext(textWindowSelectionFixture(true));
  try {
    const gold = freezeTextGold(context.fixture), candidates = preparedWindows(context);
    const baseline = measureTextRecall(context, candidates, limit, textRecallPolicies.original_default, gold);
    const deferred = measureTextRecall(context, candidates, limit, textRecallPolicies.deferred_new_text, gold);
    expect(compareSourceExposure(baseline, deferred).every(row => row.status === "retained")).toBe(true);
    expect(deferred.pages_for_all_gold).toBeNull();
    expect(deferred.delivery_truncated).toBe(false);
  } finally { await context.close(); }
}, 120_000);

it("uses native progress when every raw root awaits a separate proof page", async () => {
  const context = await nativeSubsetContext(textWindowSelectionFixture(true, 5));
  try {
    const gold = freezeTextGold(context.fixture), candidates = preparedWindows(context);
    const deferred = measureTextRecall(context, candidates, 51_708, textRecallPolicies.deferred_new_text, gold);
    expect(deferred.pages_for_all_gold).toBe(5);
    expect(deferred.eventual_proof_claims).toHaveLength(5);
    expect(deferred.delivery_truncated).toBe(false);
  } finally { await context.close(); }
}, 120_000);

it("retains the fitted raw incumbent when optional novelty accounting is exhausted", async () => {
  const context = await nativeSubsetContext(textWindowSelectionFixture(true));
  const retain = SourceSemanticResourceLedger.prototype.retain;
  try {
    const gold = freezeTextGold(context.fixture), candidates = preparedWindows(context);
    const raw = measureTextRecall(context, candidates, 51_708, textRecallPolicies.raw_only, gold);
    let interrupted = false;
    const observe = vi.spyOn(SourceSemanticResourceLedger.prototype, "retain").mockImplementation(function (this: SourceSemanticResourceLedger, value, phase) {
      if (phase === "novel source text" && !interrupted) {
        interrupted = true;
        this.reserve(this.work + 1, 0, "optional novelty interruption");
      }
      return retain.call(this, value, phase);
    });
    try {
      const deferred = measureTextRecall(context, candidates, 51_708, textRecallPolicies.deferred_new_text, gold);
      expect(interrupted).toBe(true);
      expect(deferred.first_page_roots).toEqual(raw.first_page_roots);
      expect(deferred.budget_rejections.some(row => row.phase === "optional novelty interruption")).toBe(true);
      expect(deferred.delivery_truncated).toBe(false);
    } finally { observe.mockRestore(); }
  } finally { await context.close(); }
}, 120_000);

it("defers a long-source raw twin until its complete proof window fits a native continuation", async () => {
  const context = await nativeSubsetContext(textWindowSelectionFixture(true));
  try {
    const gold = freezeTextGold(context.fixture), candidates = preparedWindows(context);
    const baseline = measureTextRecall(context, candidates, 51_708, textRecallPolicies.original_default, gold);
    const prior = measureTextRecall(context, candidates, 51_708, textRecallPolicies.new_text_per_byte, gold);
    const deferred = measureTextRecall(context, candidates, 51_708, textRecallPolicies.deferred_new_text, gold);
    expect(baseline.pages_for_all_gold).toBe(5);
    expect(prior.pages_for_all_gold).toBeNull();
    expect(deferred.recall_at_5).toBe(prior.recall_at_5);
    expect(deferred.pages_for_all_gold).toBe(2);
    expect(deferred.delivery_truncated).toBe(false);
    expect(deferred.selector_work).toBeLessThanOrEqual(baseline.selector_work * 3);
    expect(compareSourceExposure(baseline, deferred).every(row => row.status === "retained")).toBe(true);
  } finally { await context.close(); }
}, 120_000);

const pools = {
  alternatives: () => alternativeSelectionFixture(selectionExecutionBudget),
  coverage: () => coverageSelectionFixture(selectionExecutionBudget),
  raw_five: () => alternativeSelectionFixture(selectionExecutionBudget),
  long_source: () => textWindowSelectionFixture(true),
  redundant_proof: () => textWindowSelectionFixture(false)
};

it("exposes line-ranking inflation without treating novelty as relevance", () => {
  expect(previewNoveltyBytes("abc", "abcdef")).toBe(6); // Only three characters are new.
  expect(previewNoveltyBytes("", "irrelevant\nirrelevant")).toBe(20); // One repeated ten-byte string.
  expect(previewNoveltyBytes("relevant fact", "irrelevant annotation")).toBeGreaterThan(0);
});

it.each(["partial_overlap", "repeated_lines", "irrelevant_novel"] as const)(
  "freezes %s source-window controls before native policy delivery", async control => {
    const context = await nativeSubsetContext(previewNoveltySelectionFixture(control));
    try {
      const gold = freezeTextGold(context.fixture), candidates = preparedWindows(context);
      await persistArtifact("text-recall-controls", `${control}-gold.json`, { gold, sources: context.fixture.sources.map(({ id, body }) => ({ id, body })) });
      const raw = candidates.find(row => row.proofs.length === 0)!, proof = candidates.find(row => row.proofs.length > 0)!;
      expect(proof.preview).toContain("Deployment Cedar permission granted.");
      expect(proof.preview).toContain("Deployment Cedar backup completed.");
      expect(raw.entry.target.kind === "source_evidence" && raw.entry.target.span?.content_end).toBeGreaterThan(
        proof.entry.target.kind === "source_evidence" ? proof.entry.target.span?.content_start ?? 0 : 0);
      expect(raw.entry.target.kind === "source_evidence" && raw.entry.target.span?.content_end).toBeLessThan(
        proof.entry.target.kind === "source_evidence" ? proof.entry.target.span?.content_end ?? 0 : 0);
      expect(previewNoveltyBytes(raw.preview, proof.preview)).toBeGreaterThan(0);
      const limits = selectionGapLimits(context, candidates.filter(row => row.proofs.length > 0));
      const rows = limits.map(limit => ({ limit, policies: Object.fromEntries(Object.entries(textRecallPolicies).map(([name, selector]) =>
        [name, measureTextRecall(context, candidates, limit, selector, gold)])) }));
      await persistArtifact("text-recall-controls", `${control}.json`, { limits, legacy_line_novelty: {
        unit: "nonmatching_line_bytes", value: previewNoveltyBytes(raw.preview, proof.preview),
        role: "private_ranking_control_not_source_position_exposure" },
        rows: rows.map(row => ({ ...row, baseline_exposure: compareSourceExposure(row.policies["original_default"]!, row.policies["deferred_new_text"]!) })) });
      expect(rows.every(row => row.policies["deferred_new_text"]!.selector_work <= row.policies["original_default"]!.selector_work * 3)).toBe(true);
    } finally { await context.close(); }
  }, 120_000);

const enabled = process.env["ALAYA_SELECTION_POLICY_SCAN"] === "1";
for (const [name, make] of Object.entries(pools)) {
  it.skipIf(!enabled)(`measures gold-free policies on frozen ${name} text gold`, async () => {
    const context = await nativeSubsetContext(make());
    try {
      const gold = freezeTextGold(context.fixture);
      await persistArtifact("text-recall", `${name}-gold.json`, { original: context.fixture.original, gold,
        max_work_ratio: 3, scope: "authored page-1 text retrieval, not consumer benefit" });
      const candidates = name === "long_source" || name === "redundant_proof" ? preparedWindows(context)
        : context.fixture.pool.flatMap(row => [rawSourceTwin(row), row]);
      const proofSizes = selectionGapLimits(context, candidates.filter(row => row.proofs.length > 0));
      const rawBytes = measureNativeSubset(context, roomyDeliveryBytes, undefined, candidates, textRecallPolicies.raw_only).encoded_bytes;
      const frozen = process.env["ALAYA_SELECTION_FROZEN_LIMITS_DIR"];
      const limits: number[] = frozen === undefined
        ? [...new Set([...proofSizes, rawBytes - 200, rawBytes + 200])].sort((a, b) => a - b)
        : (JSON.parse(await readFile(join(frozen, `${name}.json`), "utf8")) as { limits: number[] }).limits;
      const rows = limits.map(limit => ({ limit, policies: Object.fromEntries(Object.entries(textRecallPolicies).map(([policy, selector]) => {
        try {
          const result = measureTextRecall(context, candidates, limit, selector, gold);
          expect(result.encoded_bytes).toBeLessThanOrEqual(limit);
          expect(new Set(result.first_page_roots).size).toBe(result.first_page_roots.length);
          expect(result.first_page_roots.length).toBeLessThanOrEqual(5);
          expect(result.retained_proof_claims.every(proof => proof.world_claim === "unknown" && proof.semantic_status === "unreviewed")).toBe(true);
          return [policy, result];
        } catch (error) {
          if (!(error instanceof SourceSemanticResourceExhausted)) throw error;
          return [policy, { exhausted: true, phase: error.phase, recall_at_5: null }];
        }
      })) }));
      await persistArtifact("text-recall", `${name}.json`, { limits, rows });
      console.log(JSON.stringify({ pool: name, limits: limits.length, measured: rows.length * Object.keys(textRecallPolicies).length }));
    } finally { await context.close(); }
  }, 600_000);
}
