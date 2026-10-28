import { afterEach, expect, it, vi } from "vitest";
import { sourceRecallTarget } from "@do-soul/alaya-protocol";
import { SqliteFieldSourceRecordRepo, type StorageDatabase } from "@do-soul/alaya-storage";
import { runConditionalFieldRecallWithReceipt } from "../../../recall/runtime/recall-service-runner.js";
import { captureIndexPreviews } from "../../../recall/runtime/recall-index-commit.js";
import { evictIssuedDeliveries, fieldResumeKey, assertMembershipContinuation, restoreField }
  from "../../../recall/runtime/index-continuation.js";
import { readersFor } from "../conditional-field-oracle/bound-producer.js";
import { defaultBudget, FAR_FUTURE_EXPIRY } from "../conditional-field/reference/deployment.fixture.js";
import { NOW, WS, openSourceSlice } from "../conditional-field/vertical/source-slice.js";
import { fieldSha256, hashedRecord } from "../../../../../../packages/storage/src/__tests__/repos/field/field-contract-fixture.js";

const databases = new Set<StorageDatabase>();
afterEach(() => { for (const database of databases) database.close(); databases.clear(); });

it("keeps rejected source proofs terminal while their body-only capability delivers actual bytes", async () => {
  const slice = await openSourceSlice(database => databases.add(database));
  const body = "needle body remains readable after proof refusal";
  const record = hashedRecord(WS, body, "payload-proof");
  new SqliteFieldSourceRecordRepo(slice.database, fieldSha256).insert(record);
  const target = sourceRecallTarget({ workspace_id: WS, root_kind: "source_record", root_id: record.record_id,
    source_version: record.source_version, content_digest: record.content_digest, evidence_object_id: record.evidence_object_id });
  const native = readersFor(slice);
  const read = vi.fn(native.sourceRoot!);
  const request = { workspace_id: WS, query_text: "needle", snapshot_id: `sha256:${"a".repeat(64)}`,
    interpretation_clock: NOW, as_of: NOW, lifetime_now: NOW, expires_at: FAR_FUTURE_EXPIRY,
    authorized_scopes: null, result_kind_view: "source_only" as const, readers: { ...native, sourceRoot: read } };
  const prepared = runConditionalFieldRecallWithReceipt({ ...request, budget: defaultBudget({ page_budget: 0 }) });
  expect(prepared.index.continuation).not.toBeNull();
  const rejected = runConditionalFieldRecallWithReceipt({ ...request, continuation: prepared.index.continuation,
    budget: defaultBudget({ memory_bytes: 22_000, page_budget: 1, min_envelope: 1 }) });
  expect(rejected.index.entries, JSON.stringify(rejected.index.completeness)).toHaveLength(1);
  expect(rejected.index.entries[0]?.target.kind).toBe("source_evidence");
  expect(rejected.index.completeness.payload).toBe("resource_rejected");
  expect(rejected.index.entries[0]?.explanation_ids).toEqual([]);
  expect(rejected.index.explanations ?? []).toEqual([]);
  const continuation = rejected.index.continuation;
  expect(continuation).not.toBeNull();
  expect(() => assertMembershipContinuation(continuation)).toThrowError();
  const before = read.mock.calls.length;
  expect(() => runConditionalFieldRecallWithReceipt({ ...request, continuation, budget: defaultBudget({ page_budget: 1 }) }))
    .toThrowError(expect.objectContaining({ details: expect.objectContaining({ resource: "continuation_purpose" }) }));
  expect(read).toHaveBeenCalledTimes(before);

  const expansion = { ...request, continuation, budget: defaultBudget({ page_budget: 1 }),
    payload_continuation: { schema_version: 1 as const, purpose: "payload_expansion" as const,
      target, start_offset: 0, byte_budget: 128 } };
  const expanded = runConditionalFieldRecallWithReceipt(expansion);
  expect([...captureIndexPreviews(expanded.index, {}, WS).values()]).toContain(body);
  expect(expanded.execution_receipt.actual?.phases.payload.native_bytes).toBeGreaterThan(0);
  expect(expanded.index.completeness.payload).toBe("resource_rejected");
  const after = read.mock.calls.length;
  const replayed = runConditionalFieldRecallWithReceipt(expansion);
  expect(replayed.index.page_purpose).toBe("retry");
  expect(replayed.index.completeness.payload).toBe("resource_rejected");
  expect(read).toHaveBeenCalledTimes(after);

  const retained = restoreField(continuation);
  evictIssuedDeliveries(fieldResumeKey(rejected.index.query_id, rejected.index.snapshot_id, rejected.index.interpretation_id!));
  expect(restoreField(continuation)).toBe(retained);
  expect(() => assertMembershipContinuation(continuation)).toThrowError();
  expect(() => runConditionalFieldRecallWithReceipt({ ...request, continuation, budget: defaultBudget({ page_budget: 1 }) }))
    .toThrowError(expect.objectContaining({ details: expect.objectContaining({ resource: "continuation_purpose" }) }));
  expect(read).toHaveBeenCalledTimes(after);
  const missingReceipt = runConditionalFieldRecallWithReceipt({ ...expansion,
    payload_continuation: { ...expansion.payload_continuation, byte_budget: 127 } });
  expect(missingReceipt.index.completeness.logical_index).toBe("invalidated");
  expect(read).toHaveBeenCalledTimes(after);

  const ample = runConditionalFieldRecallWithReceipt({ ...request, budget: defaultBudget({ page_budget: 1 }) });
  expect(ample.index.entries).toHaveLength(1);
  expect(ample.index.completeness.payload).toBe("complete");
  expect(ample.index.entries[0]?.explanation_ids.length).toBeGreaterThan(0);
  expect(ample.index.explanations?.length).toBeGreaterThan(0);
});
