import { afterEach, describe, expect, it } from "vitest";
import {
  InformationIndexSchema,
  MemoryDimension,
  sourceIndexEntry,
  type Continuation,
  type InformationIndex
} from "@do-soul/alaya-protocol";
import { type StorageDatabase } from "@do-soul/alaya-storage";
import {
  RecallService,
  capableRecallConsumerDeclaration,
  captureIndexPreviews,
  captureIndexSourceMetadata,
  encodeRecallResult,
  issuedDeliveryIdOf,
  runConditionalFieldRecallWithReceipt
} from "../../../recall/recall-service.js";
import {
  commitIssuedDelivery,
  pendingIssuedDeliveryOf
} from "../../../recall/runtime/recall-index-commit.js";
import {
  productIdOfEntry,
  replayIssuedDelivery
} from "../../../recall/runtime/index-continuation.js";
import { readersFor } from "../conditional-field-oracle/bound-producer.js";
import {
  FAR_FUTURE_EXPIRY,
  defaultBudget
} from "../conditional-field/reference/deployment.fixture.js";
import { MEM, NOW, WS, openSourceSlice } from "../conditional-field/vertical/source-slice.js";
import { createDependencies, createTaskSurface } from "../recall-service-test-fixtures.js";

const databases = new Set<StorageDatabase>();
const SNAPSHOT = `sha256:${"a".repeat(64)}`;

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("issued delivery commit", () => {
  it("treats sequential first-page recalls with omitted continuation as independent observation epochs", async () => {
    // Retrying that issued page request within the valid process lifetime
    // replays the same page/delivery identity. A first request with
    // continuation omitted is a new observation epoch, not an issued-page retry.
    const slice = await openSourceSlice((database) => databases.add(database));
    for (const [index, id] of [MEM.r, MEM.c, MEM.h].entries()) {
      await slice.writeMemory(id, `needle ${index}`, MemoryDimension.FACT);
    }
    const first = encodeAndIssue(recall(slice, null));
    const second = encodeAndIssue(recall(slice, null));
    expect(first.issued_delivery_id).toBeDefined();
    expect(second.issued_delivery_id).toBeDefined();
    expect(first.issued_delivery_id).not.toBe(second.issued_delivery_id);
    expect(second.index.page_purpose).not.toBe("retry");
    expect(replayIssuedDelivery("root")).toBeUndefined();
    expect(first.execution_receipt.actual?.phases.observe.state_creates).toBeGreaterThan(0);
    expect(second.execution_receipt.actual?.phases.observe.state_creates).toBeGreaterThan(0);
  });

  it("replays the same issued_delivery_id when retrying with the prior page continuation token", async () => {
    const slice = await openSourceSlice((database) => databases.add(database));
    for (const [index, id] of [MEM.r, MEM.c, MEM.h].entries()) {
      await slice.writeMemory(id, `needle ${index}`, MemoryDimension.FACT);
    }
    const pages = collectIssuedPages(slice, 8);
    expect(pages.length).toBeGreaterThan(1);
    const last = pages.at(-1)!;
    expect(last.index.continuation).toBeNull();
    expect(last.issued_delivery_id).toBeDefined();
    const prior = pages.at(-2)!;
    expect(prior.index.continuation).not.toBeNull();
    const retry = encodeAndIssue(recall(slice, prior.index.continuation));
    expect(retry.index.page_purpose).toBe("retry");
    expect(retry.issued_delivery_id).toBe(last.issued_delivery_id);
    expect(retry.index.entries.map((entry) => entry.object_id))
      .toEqual(last.index.entries.map((entry) => entry.object_id));
  });

  it("does not remember an issued digest when encode throws before commitIssuedDelivery", () => {
    const continuation = issuedContinuation("encode-after-commit-page");
    const index = memoryIndex();
    expect(replayIssuedDelivery(continuation.continuation_id)).toBeUndefined();
    expect(() => encodeThenIssue(index, continuation, () => {
      throw new Error("encoder rejection");
    })).toThrow("encoder rejection");
    expect(replayIssuedDelivery(continuation.continuation_id)).toBeUndefined();
    const issued = encodeThenIssue(index, continuation, () => encodeRecallResult(index));
    expect(replayIssuedDelivery(continuation.continuation_id)?.delivery_id).toBe(issued);
    expect(encodeRecallResult(index).index.entries.map(productIdOfEntry))
      .toEqual(index.entries.map(productIdOfEntry));
  });

  it("issues the encoded continuation page through RecallService.recall", async () => {
    // encodeRecallResult has no rejection path that drops membership identities;
    // the issued ledger stores the encoded product ids.
    const slice = await openSourceSlice((database) => databases.add(database));
    for (const [index, id] of [MEM.r, MEM.c, MEM.h].entries()) {
      await slice.writeMemory(id, `needle ${index}`, MemoryDimension.FACT);
    }
    const service = new RecallService({
      ...createDependencies().dependencies,
      now: () => NOW,
      observerReaders: readersFor(slice)
    });
    const request = {
      taskSurface: { ...createTaskSurface(), display_name: "needle" },
      workspaceId: WS,
      strategy: "chat" as const,
      queryText: "needle",
      pageBudget: 1,
      budget: defaultBudget({
        work_units: 2_000, page_budget: 1, finalization_reserve: 20, min_envelope: 1
      }),
      ...capableRecallConsumerDeclaration()
    };
    const first = await service.recall(request);
    expect(first.index.continuation).not.toBeNull();
    const digest = first.index.continuation!.continuation_id;
    expect(replayIssuedDelivery(digest)).toBeUndefined();
    const second = await service.recall({ ...request, continuation: first.index.continuation });
    expect(second.issued_delivery_id).toBeDefined();
    expect(replayIssuedDelivery(digest)?.delivery_id).toBe(second.issued_delivery_id);
    expect(replayIssuedDelivery(digest)?.member_ids)
      .toEqual(second.index.entries.map(productIdOfEntry));
  });

  it("keeps every index.entries identity when encodeRecallResult omits preview", () => {
    const index = mixedIndex();
    const encoded = encodeRecallResult(index, new Map());
    expect(encoded.candidates).toHaveLength(index.entries.length);
    expect(encoded.index.entries.map(productIdOfEntry)).toEqual(index.entries.map(productIdOfEntry));
    const source = encoded.candidates.find((candidate) => candidate.object_kind === "source_evidence");
    expect(source).toBeDefined();
    expect(source?.object_id).toBeUndefined();
  });

  it("stages a continuation page without writing ISSUED_PAGES until encode succeeds", async () => {
    const slice = await openSourceSlice((database) => databases.add(database));
    for (const [index, id] of [MEM.r, MEM.c, MEM.h].entries()) {
      await slice.writeMemory(id, `needle ${index}`, MemoryDimension.FACT);
    }
    const first = recall(slice, null, "defer");
    expect(first.index.continuation).not.toBeNull();
    encodeAndIssue(first);
    const second = recall(slice, first.index.continuation, "defer");
    const digest = first.index.continuation?.continuation_id;
    expect(digest).toBeDefined();
    expect(pendingIssuedDeliveryOf(second.index)).toBeDefined();
    expect(replayIssuedDelivery(digest!)).toBeUndefined();
    const encoded = encodeAndIssue(second);
    expect(replayIssuedDelivery(digest!)?.delivery_id).toBe(encoded.issued_delivery_id);
  });
});

function recall(
  slice: Awaited<ReturnType<typeof openSourceSlice>>,
  continuation: InformationIndex["continuation"],
  issue: "now" | "defer" = "now"
) {
  const budget = defaultBudget({
    work_units: 2_000, page_budget: 1, finalization_reserve: 20, min_envelope: 1
  });
  return runConditionalFieldRecallWithReceipt({
    workspace_id: WS,
    query_text: "needle",
    budget,
    requested_budget: budget,
    snapshot_id: SNAPSHOT,
    interpretation_clock: NOW,
    as_of: NOW,
    expires_at: FAR_FUTURE_EXPIRY,
    lifetime_now: NOW,
    readers: readersFor(slice),
    continuation,
    protocol_version: 1,
    supports_source_evidence: true,
    supported_result_kinds: ["memory_entry", "source_evidence"],
    authorized_scopes: null
  }, { issue });
}

function encodeAndIssue(executed: ReturnType<typeof runConditionalFieldRecallWithReceipt>) {
  const previews = captureIndexPreviews(executed.index, {}, WS);
  const metadata = captureIndexSourceMetadata(executed.index);
  const encoded = encodeRecallResult(executed.index, previews, undefined, metadata);
  const issued_delivery_id = executed.issue?.({ index: encoded.index, previews, metadata })
    ?? issuedDeliveryIdOf(executed.index);
  return { ...executed, index: encoded.index, issued_delivery_id };
}

function collectIssuedPages(
  slice: Awaited<ReturnType<typeof openSourceSlice>>,
  maximum: number
) {
  const pages: ReturnType<typeof encodeAndIssue>[] = [];
  let continuation: InformationIndex["continuation"] = null;
  for (let attempt = 0; attempt < maximum; attempt += 1) {
    const page = encodeAndIssue(recall(slice, continuation));
    pages.push(page);
    continuation = page.index.continuation;
    if (continuation === null) break;
  }
  return pages;
}

function encodeThenIssue(
  index: InformationIndex,
  request: Continuation,
  encode: () => ReturnType<typeof encodeRecallResult>
): string {
  const encoded = encode();
  return commitIssuedDelivery({
    query_key: `${index.query_id}\0${index.snapshot_id}`,
    request_digest: request.continuation_id,
    index: encoded.index,
    request
  });
}

function issuedContinuation(continuation_id: string): Continuation {
  return {
    schema_version: 1,
    continuation_id,
    query_id: "issued-commit",
    snapshot_id: SNAPSHOT,
    result_version: "v1",
    expires_at: FAR_FUTURE_EXPIRY,
    cursor: "offset-1"
  };
}

function memoryIndex(): InformationIndex {
  return mixedIndex([memoryEntry()]);
}

function mixedIndex(entries: InformationIndex["entries"] = [memoryEntry(), sourceEntry()]): InformationIndex {
  return InformationIndexSchema.parse({
    schema_version: 1,
    query_id: "issued-commit",
    snapshot_id: SNAPSHOT,
    result_version: "v1",
    entries,
    completeness: {
      schema_version: 1,
      logical_index: "open",
      observed_coverage: "open",
      transport: "complete",
      payload: "complete",
      representation: "complete"
    },
    continuation: null,
    representation: {
      schema_version: 1,
      policy: "construct_index_then_page_then_payload",
      page_budget: entries.length,
      identity_tie_break: "serialization"
    }
  });
}

function memoryEntry() {
  return {
    schema_version: 1 as const,
    object_id: MEM.r,
    target: { kind: "memory_entry" as const, workspace_id: WS, object_id: MEM.r, source_revision: "rev" },
    hypothesis_id: "h0",
    output_binding: "default",
    role: "requested" as const,
    association_milligrades: 850,
    claim: "unknown" as const,
    explanation_ids: [],
    program_state: "matched",
    time_state: "current"
  };
}

function sourceEntry() {
  return sourceIndexEntry({
    workspace_id: WS,
    root_kind: "source_record",
    root_id: "rec-1",
    source_version: "v1",
    content_digest: SNAPSHOT,
    evidence_object_id: null,
    association_milligrades: 700,
    hypothesis_id: "h1",
    output_binding: "default",
    program_state: "matched",
    time_state: "current"
  });
}
