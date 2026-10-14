import { describe, expect, it } from "vitest";
import { explainCompletionTarget, libraryPageOrder } from "../../../../recall/conditional-field/index/completion-target.js";
import { assembleSourceSemanticLibraryIndex } from "../../../../recall/runtime/source-semantic-library-recall.js";
import { sourceIndexEntry, type IndexEntry } from "@do-soul/alaya-protocol";

const DIGEST = `sha256:${"ab".repeat(32)}`;

function source(root: string): IndexEntry {
  return sourceIndexEntry({
    workspace_id: "ws", root_kind: "source_record", root_id: root, source_version: "1",
    content_digest: DIGEST, evidence_object_id: null, association_milligrades: 0,
    program_state: "accepting", time_state: "as_of"
  });
}

function page(overrides: { truncated?: boolean; open_residuals?: boolean; more_roots?: boolean }) {
  return assembleSourceSemanticLibraryIndex({
    query_id: "library-query", snapshot_id: `sha256:${"cd".repeat(32)}`, interpretation_id: "library-interpretation",
    as_of: "2026-09-18T00:00:00.000Z", proof_groups: [], source_entries: [source("gold")],
    truncated: overrides.truncated ?? false, open_residuals: overrides.open_residuals ?? false,
    more_roots: overrides.more_roots
  }).index;
}

describe("completion target explanation", () => {
  it("does not treat payload completion, a null continuation or an empty queue as membership", () => {
    expect(explainCompletionTarget({
      continuation_present: false, delivered_count: 0
    })).toEqual({ achieved: "none", remaining_obligations: ["membership", "observed", "order"] });
  });

  it("does not upgrade a raw closed page or a contradictory order claim", () => {
    expect(explainCompletionTarget({
      logical_index: "complete", observed_coverage: "complete", order_status: "complete",
      order_coverage: "complete", delivered_count: 1, source_only: true
    })).toMatchObject({ achieved: "reliable_partial", remaining_obligations: ["source_only"] });
    expect(explainCompletionTarget({
      logical_index: "complete", observed_coverage: "complete", order_status: "open",
      order_coverage: "complete", delivered_count: 1, supported_delivery: true
    }).achieved).toBe("reliable_partial");
  });

  it("keeps a certified prefix behind its tail and refuses it after resource exhaustion", () => {
    expect(explainCompletionTarget({
      logical_index: "partial", observed_coverage: "open", order_status: "certified_prefix",
      delivered_count: 1, supported_delivery: true
    })).toMatchObject({ achieved: "certified_prefix", remaining_obligations: ["membership", "observed", "order_tail"] });
    expect(explainCompletionTarget({
      outcome_status: "resource_exhausted", order_status: "certified_prefix", delivered_count: 1,
      supported_delivery: true
    }).achieved).toBe("reliable_partial");
  });

  it("keeps library order open when an earlier unseen root or a later page remains", () => {
    expect(libraryPageOrder({ open_residuals: true, truncated: false, more_roots: false, page_remainder: false }))
      .toEqual({ order_status: "open", order_coverage: "open" });
    for (const index of [page({ open_residuals: true }), page({ truncated: true }), page({ more_roots: true })]) {
      expect(index.order_status).toBe("open");
      expect(index.completeness.order_coverage).not.toBe("complete");
      expect(index.completeness.logical_index).toBe("partial");
    }
  });

  it("does not let an explicit false more_roots hide a local tail or omit observation", () => {
    const hidden = assembleSourceSemanticLibraryIndex({
      query_id: "library-query", snapshot_id: `sha256:${"cd".repeat(32)}`, interpretation_id: "library-interpretation",
      as_of: "2026-09-18T00:00:00.000Z", proof_groups: [],
      source_entries: Array.from({ length: 6 }, (_, index) => source(`root-${String(index)}`)),
      truncated: false, open_residuals: false, more_roots: false
    }).index;
    expect(hidden.entries).toHaveLength(5);
    expect(hidden.continuation).not.toBeNull();
    expect(hidden.order_status).toBe("open");
    expect(hidden.completeness.order_coverage).toBe("open");
    expect(explainCompletionTarget({
      logical_index: "complete", order_status: "complete", order_coverage: "complete",
      delivered_count: 1, supported_delivery: true
    }).remaining_obligations).toContain("observed");
  });
});
