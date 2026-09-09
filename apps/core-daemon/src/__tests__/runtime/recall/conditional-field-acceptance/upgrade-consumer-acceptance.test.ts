import { afterEach, describe, expect, it } from "vitest";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  type InformationIndex
} from "@do-soul/alaya-protocol";
import { type StorageDatabase } from "@do-soul/alaya-storage";
import { encodeIndexResults } from "../../../../mcp-memory/recall/recall-result.js";
import { COMPATIBILITY_LEDGER } from "../../../../../../../packages/protocol/src/__tests__/recall/conditional-field/compatibility-ledger.fixture.js";
import {
  defaultBudget,
  openBoundSlice,
  plantDeployment,
  plantNeedles,
  recallThroughHandler,
  runRecall
} from "./planted-handler.js";
import {
  PAYLOAD_OMITTED_PREVIEW,
  assertIndexPreservesProductIdentity,
  assertInterpretationCoverageHonest,
  assertNoRetiredSelectorKeys,
  assertPreviewIsSourceExcerpt,
  assertResultsDoNotReselect,
  physicalDeletionIsOutOfBand,
  plantedEmptyPreview,
  plantedFlattenedResultsDropIdentity
} from "./upgrade-consumer-contract.js";

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("conditional-field upgrade consumer falsifiers", () => {
  it("handler index is inspected, not assumed complete", async () => {
    const slice = await openBoundSlice((database) => databases.add(database));
    await plantDeployment(slice);
    const mcp = await recallThroughHandler(slice, {
      query: "yesterday failed deployment",
      max_results: 800
    });
    expect(mcp.index.entries.length).toBeGreaterThan(0);
    const identityFailures = assertIndexPreservesProductIdentity(mcp.index);
    expect(identityFailures).toEqual([]);
    expect(mcp.results.every((result) =>
      result.program_state !== undefined && result.time_state !== undefined
    )).toBe(true);
    expect(mcp.index.completeness.interpretation_coverage).toBeDefined();
  });

  it("planted: encodeIndexResults cannot credit a witness from an output-only receipt", () => {
    const index = sampleIndex([
      {
        object_id: "cfg",
        explanation_ids: ["w1", "w2"],
        program_state: "accepting",
        time_state: "yesterday"
      }
    ]);
    const encoded = encodeIndexResults(index, new Map([["cfg", "last-week configuration"]]));
    expect(encoded[0]?.evidence_pointers).toEqual([]);
    expect(encoded[0]?.program_state).toBe("accepting");
    expect(encoded[0]?.time_state).toBe("yesterday");
    const outputOnlyReceipt = { grain: "output", output_id: "cfg", reported_use: "used" };
    const plantedCredit = outputOnlyReceipt.grain === "output" ? encoded[0]?.evidence_pointers : [];
    expect(plantedCredit).toEqual([]);
    expect(outputOnlyReceipt.grain).not.toBe("witness");
  });

  it("contract-only: compatibility says feedback is unreachable; packaging is not this band", () => {
    const feedback = COMPATIBILITY_LEDGER.find((row) => row.field === "operational_feedback");
    expect(feedback?.disposition).toBe("unreachable-on-target");
    expect(COMPATIBILITY_LEDGER.find((row) => row.field === "persisted_old_receipts")?.disposition)
      .toBe("freeze-live");
    expect(physicalDeletionIsOutOfBand("physical_absence")).toBe(true);
    expect(physicalDeletionIsOutOfBand("exclusivity")).toBe(false);
  });

  it("planted: MCP result rows flatten program_state while the index may still carry it", () => {
    const index = sampleIndex([
      {
        object_id: "cfg",
        explanation_ids: [],
        program_state: "accepting",
        time_state: "yesterday"
      }
    ]);
    const encoded = encodeIndexResults(index, new Map([["cfg", "configuration change"]]));
    expect(plantedFlattenedResultsDropIdentity(encoded as unknown as Record<string, unknown>[])).toBe(false);
    expect(index.entries[0]?.program_state).toBe("accepting");
  });

  it("plants worker-preview residual: empty map hydrates omitted placeholder, not the source excerpt", async () => {
    const slice = await openBoundSlice((database) => databases.add(database));
    await plantDeployment(slice);
    const mcp = await recallThroughHandler(slice, {
      query: "yesterday failed deployment",
      max_results: 800
    });
    const excerpt = "yesterday failed deployment of checkout";
    const omitted = encodeIndexResults(mcp.index, new Map())[0]?.content_preview ?? "";
    expect(plantedEmptyPreview(omitted)).toBe(true);
    expect(assertPreviewIsSourceExcerpt(omitted, excerpt).length).toBeGreaterThan(0);
    expect(omitted).toBe(PAYLOAD_OMITTED_PREVIEW);
    expect(mcp.results.length).toBeGreaterThan(0);
  });

  it("handler encoding still does not reselect or restore retired selector keys", async () => {
    const slice = await openBoundSlice((database) => databases.add(database));
    await plantNeedles(slice, 6, 961);
    const mcp = await recallThroughHandler(slice, { query: "needle", max_results: 800 });
    expect(assertResultsDoNotReselect(mcp.results, mcp.index)).toEqual([]);
    expect(assertNoRetiredSelectorKeys(mcp)).toEqual([]);
    expect("ranking_authority" in mcp).toBe(false);
    expect("delivery_path" in mcp).toBe(false);
  });

  it("continuation identity is still query/snapshot/result, not a second selector", async () => {
    const slice = await openBoundSlice((database) => databases.add(database));
    await plantNeedles(slice, 8, 971);
    const first = await recallThroughHandler(slice, { query: "needle", max_results: 1 });
    const second = runRecall(slice, {
      query_text: "needle",
      budget: defaultBudget({ page_budget: 1 }),
      continuation: first.index.continuation
    });
    if (second.completeness.observed_coverage === "invalidated") {
      expect(second.completeness.logical_index).not.toBe("complete");
    } else {
      expect(second.query_id).toBe(first.index.query_id);
      expect(second.snapshot_id).toBe(first.index.snapshot_id);
    }
  });
});

function sampleIndex(
  entries: readonly {
    readonly object_id: string;
    readonly explanation_ids: readonly string[];
    readonly program_state: string;
    readonly time_state: string;
  }[]
): InformationIndex {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    query_id: "failed-deployment",
    snapshot_id: `sha256:${"b".repeat(64)}`,
    result_version: "v1",
    entries: entries.map((entry) => ({
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      object_id: entry.object_id,
      hypothesis_id: "h0",
      output_binding: "requested",
      role: "associated" as const,
      association_milligrades: 850,
      claim: "unknown" as const,
      explanation_ids: entry.explanation_ids,
      program_state: entry.program_state,
      time_state: entry.time_state
    })),
    completeness: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      logical_index: "complete",
      observed_coverage: "complete",
      transport: "complete",
      payload: "complete",
      representation: "complete"
    },
    continuation: null,
    representation: {
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      policy: "construct_index_then_page_then_payload",
      page_budget: 800,
      identity_tie_break: "serialization"
    }
  };
}
