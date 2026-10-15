import { afterAll, afterEach, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterEach(() => { expect(isolation.violations).toEqual([]); });
afterAll(() => { isolation.restore(); });
import { SourceSemanticResourceExhausted } from "@do-soul/alaya-protocol";
import { alternativeSelectionFixture, coverageSelectionFixture, rawSourceTwin, selectionExecutionBudget, textWindowSelectionFixture }
  from "../../../../../../packages/core/src/__tests__/recall/runtime/source-semantic-selection-fixture.js";
import { prepareLibraryPackages } from "../../../runtime/recall-read-worker/source-semantic-library-packages.js";
import { SourceSemanticReadBudget } from "../../../runtime/field/source-semantic-read-stores.js";
import { measureNativeSubset, nativeSubsetContext, persistArtifact, roomyDeliveryBytes, type NativeSubsetContext }
  from "./source-semantic-library-subset-packing.test-support.js";
import { selectionGapLimits } from "./source-semantic-library-selection-gap.test-support.js";
import { freezeTextGold, measureTextRecall, textRecallPolicies } from "./source-semantic-library-text-recall.test-support.js";

function preparedWindows(context: NativeSubsetContext) {
  const result = prepareLibraryPackages(context.runtime,
    { workspace_id: "ws", as_of: "2026-09-18T00:00:00.000Z", authorized_scopes: { mode: "named", scopes: ["project"] } } as never,
    ["project"], new SourceSemanticReadBudget(selectionExecutionBudget), context.fixture.pool.map(rawSourceTwin).map(row => row.entry),
    context.fixture.sources.map(source => ({ proof: source.package.proofs[0]!, group: source.package,
      source: source.body, dependencies: source.dependencies })));
  expect(result.incomplete).toBe(false);
  expect(result.packages.filter(row => row.proofs.length > 0)).toHaveLength(5);
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
    const novel = measureTextRecall(context, candidates, roomyDeliveryBytes, textRecallPolicies.new_text_per_byte, gold);
    expect(novel.recall_at_5).toBe(1);
    expect(novel.retained_proof_claims).toHaveLength(long ? 1 : 0);
  } finally { await context.close(); }
}, 120_000);

const pools = {
  alternatives: () => alternativeSelectionFixture(selectionExecutionBudget),
  coverage: () => coverageSelectionFixture(selectionExecutionBudget),
  raw_five: () => alternativeSelectionFixture(selectionExecutionBudget),
  long_source: () => textWindowSelectionFixture(true),
  redundant_proof: () => textWindowSelectionFixture(false)
};
const enabled = process.env["ALAYA_SELECTION_POLICY_SCAN"] === "1";
for (const [name, make] of Object.entries(pools)) {
  it.skipIf(!enabled)(`measures five gold-free policies on frozen ${name} text gold`, async () => {
    const context = await nativeSubsetContext(make());
    try {
      const gold = freezeTextGold(context.fixture);
      await persistArtifact("text-recall", `${name}-gold.json`, { original: context.fixture.original, gold,
        max_work_ratio: 3, scope: "authored page-1 text retrieval, not consumer benefit" });
      const candidates = name === "long_source" || name === "redundant_proof" ? preparedWindows(context)
        : context.fixture.pool.flatMap(row => [rawSourceTwin(row), row]);
      const proofSizes = selectionGapLimits(context, candidates.filter(row => row.proofs.length > 0));
      const rawBytes = measureNativeSubset(context, roomyDeliveryBytes, undefined, candidates, textRecallPolicies.raw_only).encoded_bytes;
      const limits = [...new Set([...proofSizes, rawBytes - 200, rawBytes + 200])].sort((a, b) => a - b);
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
