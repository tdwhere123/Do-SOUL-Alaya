import { describe, expect, it } from "vitest";

import type { BenchDaemonHandle } from "../../../harness/daemon.js";

import { withBenchDaemon } from "./bench-daemon.test-support.js";

import {
  BenchRecallDiagnosticsSchema,
  type BenchRecallDiagnostics
} from "../../../harness/recall/recall-diagnostics-schema.js";

// invariant: re-parse the recall handle's `diagnostics: unknown` field through
// the SAME BenchRecallDiagnosticsSchema the harness already applied internally,
// so the per-candidate admission-plane diagnostics are typed (no `as` cast).
// admission_planes records WHY each candidate entered the recall pool:
// "activation" / "domain_tag_cluster" = structural/content admission,
// "path_expansion" / "graph_expansion" = the unified path plane (direct 1-hop
// vs multi-hop), which exists for a candidate only when a path edge reaches it.
function findCandidateDiagnostic(
  diagnostics: unknown,
  objectId: string
): BenchRecallDiagnostics["candidates"][number] | undefined {
  if (diagnostics === undefined) {
    return undefined;
  }
  const parsed = BenchRecallDiagnosticsSchema.parse(diagnostics);
  return parsed.candidates.find((candidate) => candidate.object_id === objectId);
}

describe("BenchDaemon harness — real MCP propose+review chain", () => {
  it(
    "an earned co-recall edge contributes typed path evidence without overriding fusion budget",
    async () => {
      const DECOY_COUNT = 15;
      const FANIN_MAX_RESULTS = 12;
      const QUERY = "quarterly ledger reconciliation runbook finance vault";
      const ANCHOR_CONTENT =
        "The quarterly ledger reconciliation runbook lives in the finance vault.";
      // Content-disjoint from the query: no lexical/embedding overlap, so the
      // ONLY query-relevant route to a DELIVERY slot is the path-plane edge.
      const SIBLING_CONTENT =
        "Aurora prefers oat milk in her espresso every morning.";

      // Decoys share the query's finance/ledger vocabulary, so each is a
      // stronger content hit than the sibling — they outrank it and fill the
      // budget.
      const decoyContents = Array.from(
        { length: DECOY_COUNT },
        (_unused, i) =>
          `Ledger reconciliation note ${i}: the finance vault runbook records ` +
          `quarterly variance entry ${i} for the reconciliation ledger.`
      );

      // Shared seeding so the positive case and the negative control run on
      // byte-identical content; only edge minting differs.
      const seedFaninWorld = async (
        daemon: BenchDaemonHandle
      ): Promise<{ anchorId: string; siblingId: string }> => {
        const anchor = await daemon.proposeMemory(ANCHOR_CONTENT, "fanin-anchor", {
          objectKind: "fact"
        });
        const sibling = await daemon.proposeMemory(
          SIBLING_CONTENT,
          "fanin-sibling",
          { objectKind: "fact" }
        );
        for (let i = 0; i < decoyContents.length; i += 1) {
          await daemon.proposeMemory(decoyContents[i]!, `fanin-decoy-${i}`, {
            objectKind: "fact"
          });
        }
        return { anchorId: anchor.memoryId, siblingId: sibling.memoryId };
      };

      // ---- POSITIVE: edge minted -> sibling delivered via the path plane ----
      await withBenchDaemon(
        {
          workspaceId: "harness-co-recall-fanin-ws",
          runId: "harness-co-recall-fanin-run"
        },
        async (positiveDaemon) => {
          const positive = await seedFaninWorld(positiveDaemon);

          // Earn the co_recalled edge between anchor and sibling through the
          // production gate (decoys are NOT in the pair, so they grow no edges).
          const summary = await positiveDaemon.accrueSessionCoRecall([
            positive.anchorId,
            positive.siblingId
          ]);
          expect(summary.minted).toBe(1);

          const positiveRecall = await positiveDaemon.recall(QUERY, {
            maxResults: FANIN_MAX_RESULTS
          });
          const positiveIds = new Set(
            positiveRecall.results.map((r) => r.object_id)
          );

          // The anchor is the direct content hit.
          expect(positiveIds).toContain(positive.anchorId);
          // Structural evidence enters fusion, but cannot bypass a tight result
          // budget when stronger query-relevant candidates rank ahead of it.
          expect(positiveIds).not.toContain(positive.siblingId);
          const positiveSiblingDiag = findCandidateDiagnostic(
            positiveRecall.diagnostics,
            positive.siblingId
          );
          expect(positiveSiblingDiag).toBeDefined();
          expect(positiveSiblingDiag!.within_budget).toBe(false);
          expect(positiveSiblingDiag!.final_rank).toBeNull();
          expect(positiveSiblingDiag!.admission_planes).toContain("path_expansion");
          expect(positiveSiblingDiag!.per_stream_rank.path_expansion).not.toBeNull();
          expect(positiveSiblingDiag!.per_stream_rank.graph_expansion).not.toBeNull();
        }
      );

      // ---- NEGATIVE CONTROL: NO edge -> sibling ABSENT from recall ----
      await withBenchDaemon(
        {
          workspaceId: "harness-co-recall-fanin-negctl-ws",
          runId: "harness-co-recall-fanin-negctl-run"
        },
        async (negativeDaemon) => {
          const negative = await seedFaninWorld(negativeDaemon);
          // Deliberately DO NOT call accrueSessionCoRecall: no co_recalled edge.

          const negativeRecall = await negativeDaemon.recall(QUERY, {
            maxResults: FANIN_MAX_RESULTS
          });
          const negativeIds = new Set(
            negativeRecall.results.map((r) => r.object_id)
          );

          // The anchor still delivers (direct content hit) — the world is otherwise
          // byte-identical, isolating the edge as the only difference.
          expect(negativeIds).toContain(negative.anchorId);
          expect(negativeIds).not.toContain(negative.siblingId);
          const negativeSiblingDiag = findCandidateDiagnostic(
            negativeRecall.diagnostics,
            negative.siblingId
          );
          // The shared domain tag may still admit the sibling, but no path stream
          // may appear without the earned relation.
          if (negativeSiblingDiag !== undefined) {
            expect(negativeSiblingDiag.within_budget).toBe(false);
            expect(negativeSiblingDiag.final_rank).toBeNull();
            expect(negativeSiblingDiag.admission_planes).not.toContain(
              "path_expansion"
            );
            expect(negativeSiblingDiag.per_stream_rank.path_expansion).toBeNull();
            expect(negativeSiblingDiag.per_stream_rank.graph_expansion).toBeNull();
          }
        }
      );
    },
    120_000
  );
});
