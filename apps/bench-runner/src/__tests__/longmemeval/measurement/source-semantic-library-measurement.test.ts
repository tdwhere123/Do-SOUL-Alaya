import { describe, expect, it } from "vitest";
import {
  IndexEntrySchema, SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP, SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET,
  SourceSemanticWorkerResultSchema, type IndexEntry, type InformationIndex
} from "@do-soul/alaya-protocol";
import {
  SOURCE_SEMANTIC_LIBRARY_ORDER, assembleSourceSemanticLibraryIndex, sourceSemanticLibrarySourceEntry
} from "@do-soul/alaya-core";
import { measureConditionalFieldResponse } from "../../../runs/measurement/conditional-field-measurement.js";
import { recordSourceSemanticLibraryFirstExposure } from "../../../runs/measurement/source-semantic-library-recall.js";
import {
  measureSourceSemanticLibraryResponse
} from "../../../runs/measurement/source-semantic-library-measurement.js";
import {
  PROOF_CONDITIONED_FIRST_EXPOSURE_CONTRACT, sourceGoldUnitFromPublishedRoot
} from "../../../runs/measurement/source-gold-join.js";

const DIGEST = `sha256:${"ab".repeat(32)}`;
const CLOCK = "2026-09-18T00:00:00.000Z";
const SNAPSHOT = `sha256:${"cd".repeat(32)}`;
const REQUEST = {
  schema_version: 1 as const, work_units: 200000, memory_bytes: 20000000,
  page_budget: 100000, finalization_reserve: 10000, min_envelope: 10
};
const GOLD_TARGET = {
  kind: "source_evidence" as const, workspace_id: "ws", root_kind: "source_record" as const,
  root_id: "gold", source_version: "1", content_digest: DIGEST, evidence_object_id: null
};
const GOLD = sourceGoldUnitFromPublishedRoot(GOLD_TARGET);

function sourceOnly(root: string): IndexEntry {
  return sourceSemanticLibrarySourceEntry({
    workspaceId: "ws", root_id: root, source_version: "1", content_digest: DIGEST,
    evidence_object_id: null, hypothesis_id: "h0"
  });
}

function proofEntry(root: string): IndexEntry {
  const base = sourceOnly(root);
  return IndexEntrySchema.parse({
    ...base,
    explanation_ids: ["ex-1"],
    interpretation_node: { packet_id: "packet-1", hypothesis_id: base.hypothesis_id, node_id: "n1" }
  });
}

function assemble(entries: readonly IndexEntry[], proofs: readonly IndexEntry[]) {
  return assembleSourceSemanticLibraryIndex({
    query_id: "library-query", snapshot_id: SNAPSHOT, interpretation_id: "library-interpretation",
    as_of: CLOCK, proof_groups: proofs.length === 0 ? [] : [{ entries: proofs }],
    source_entries: entries, truncated: false, open_residuals: false
  }).index;
}

function workerRecall(index: InformationIndex) {
  const slot_qualifiers = index.entries.map((entry, offset) => ({
    index: offset,
    evidence_kind: entry.interpretation_node !== undefined && entry.explanation_ids.length > 0
      ? "semantic_proof" as const
      : "source_evidence" as const
  }));
  const result = SourceSemanticWorkerResultSchema.parse({
    kind: "recall", request_budget: REQUEST, delivery_id: "delivery", protocol_version: 1, total_count: index.entries.length,
    index, page_purpose: "membership",
    discovery: {
      eligible_source_count: index.entries.length, visited_source_pages: 1, visited_h_pages: 1,
      visited_h_descriptors: proofsPresent(index) ? 1 : 0, candidate_prefix: [],
      examined_h_ids: [], unexamined_h_count: 0, omitted_duplicate_bindings: 0,
      examination_cap: SOURCE_SEMANTIC_LIBRARY_EXAMINATION_CAP, open_residuals: false, truncated: false
    },
    order: SOURCE_SEMANTIC_LIBRARY_ORDER, slot_qualifiers,
    coverage: {
      discovery: "complete", h: proofsPresent(index) ? "open" : "unexercised",
      q: "complete", a: proofsPresent(index) ? "open" : "unexercised",
      computation: proofsPresent(index) ? "complete" : "open", payload: "complete"
    },
    work: { native_work: 0, native_bytes: 0, logical_memory_bytes: 0, rss_bytes: 0 }
  });
  if (result.kind !== "recall") throw new Error("recall expected");
  return result;
}

function proofsPresent(index: InformationIndex): boolean {
  return index.entries.some((entry) => entry.interpretation_node !== undefined && entry.explanation_ids.length > 0);
}

function measureOf(result: ReturnType<typeof workerRecall>) {
  return measureSourceSemanticLibraryResponse({
    recallResult: result,
    firstExposurePage: recordSourceSemanticLibraryFirstExposure(result),
    requestBudget: REQUEST,
    goldSourceUnits: [GOLD]
  });
}

describe("source semantic library measurement", () => {
  it("scores mixed source retrieval but rejects label-only proof claims", () => {
    const withProof = measureOf(workerRecall(assemble([sourceOnly("gold")], [proofEntry("gold")])));
    const withoutProof = measureOf(workerRecall(assemble([sourceOnly("gold")], [])));
    expect(withProof).toMatchObject({
      status: "validated", provider_calls: 0,
      request: { budget: { page_budget: REQUEST.page_budget } },
      metrics: {
        mixed_kind_first_exposure: { any_at_10: { status: "hit", value: true } },
        proof_conditioned_first_exposure: {
          contract: PROOF_CONDITIONED_FIRST_EXPOSURE_CONTRACT,
          any_at_10: { status: "unavailable", value: null }
        }
      }
    });
    expect(withoutProof).toMatchObject({
      status: "validated", provider_calls: 0,
      request: { budget: { page_budget: REQUEST.page_budget } },
      metrics: {
        mixed_kind_first_exposure: { any_at_10: { status: "hit", value: true } },
        proof_conditioned_first_exposure: { any_at_10: { status: "miss", value: false } }
      }
    });
    expect(withProof && "request" in withProof ? "execution_receipt" in withProof.request : true).toBe(false);
    expect(REQUEST.page_budget).not.toBe(SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET);
    expect(withoutProof && "metrics" in withoutProof
      ? withoutProof.metrics.mixed_kind_first_exposure.any_at_10
      : null).not.toEqual(withoutProof && "metrics" in withoutProof
      ? withoutProof.metrics.proof_conditioned_first_exposure.any_at_10
      : undefined);
    const recalled = workerRecall(assemble([sourceOnly("gold")], [proofEntry("gold")]));
    expect(measureConditionalFieldResponse({ recallResult: recalled, deliveredResults: [] })?.status)
      .not.toBe("validated");
  });

  it("fails closed when the index page_budget is not the library page", () => {
    const recalled = workerRecall(assemble([sourceOnly("gold")], []));
    const disagreed = {
      ...recalled,
      index: {
        ...recalled.index,
        representation: { ...recalled.index.representation, page_budget: REQUEST.page_budget }
      }
    };
    expect(measureSourceSemanticLibraryResponse({
      recallResult: disagreed,
      firstExposurePage: recordSourceSemanticLibraryFirstExposure(recalled),
      requestBudget: REQUEST,
      goldSourceUnits: [GOLD]
    })).toEqual({ schema_version: 1, status: "invalid", reason: "request_budget_mismatch" });
  });
});
