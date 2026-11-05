import { afterEach, expect, it } from "vitest";
import { SqliteFieldSourceRecordRepo, type StorageDatabase } from "@do-soul/alaya-storage";
import { runConditionalFieldRecallWithReceipt } from "../../../recall/runtime/recall-service-runner.js";
import { captureIndexPreviews } from "../../../recall/runtime/recall-index-commit.js";
import { readersFor } from "../conditional-field-oracle/bound-producer.js";
import { defaultBudget, FAR_FUTURE_EXPIRY } from "../conditional-field/reference/deployment.fixture.js";
import { NOW, WS, openSourceSlice } from "../conditional-field/vertical/source-slice.js";
import { fieldSha256, hashedRecord } from "../../../../../../packages/storage/src/__tests__/repos/field/field-contract-fixture.js";

const databases = new Set<StorageDatabase>();
afterEach(() => { for (const database of databases) database.close(); databases.clear(); });

it("isolates identical semantic executions through prepare, completion, replay and stale competing acknowledgment", async () => {
  const slice = await openSourceSlice(database => databases.add(database));
  new SqliteFieldSourceRecordRepo(slice.database, fieldSha256).insert(hashedRecord(WS, "needle independent execution body", "execution-body"));
  const request = { workspace_id: WS, query_text: "needle", snapshot_id: `sha256:${"a".repeat(64)}`,
    interpretation_clock: NOW, as_of: NOW, lifetime_now: NOW, expires_at: FAR_FUTURE_EXPIRY,
    authorized_scopes: null, result_kind_view: "source_only" as const, readers: readersFor(slice),
    budget: defaultBudget({ page_budget: 0 }) };
  const a = runConditionalFieldRecallWithReceipt(request, { issue: "defer" });
  const b = runConditionalFieldRecallWithReceipt(request, { issue: "defer" });
  const acknowledge = (execution: typeof a) => execution.issue!({ index: execution.index,
    previews: captureIndexPreviews(execution.index, {}, WS), metadata: {} });
  expect(a.index.query_id).toBe(b.index.query_id);
  expect(a.index.snapshot_id).toBe(b.index.snapshot_id);
  expect(a.execution_id).not.toBe(b.execution_id);
  expect(a.index.continuation).not.toBeNull();
  const aDelivery = acknowledge(a);
  acknowledge(b);
  expect(acknowledge(a)).toBe(aDelivery);
  const completeB = runConditionalFieldRecallWithReceipt({ ...request, continuation: b.index.continuation,
    budget: defaultBudget({ page_budget: 100 }) });
  expect(completeB.index.entries.length).toBeGreaterThan(0);
  const next = { ...request, continuation: a.index.continuation, budget: defaultBudget({ page_budget: 100 }) };
  const aWinner = runConditionalFieldRecallWithReceipt(next, { issue: "defer" });
  const aLoser = runConditionalFieldRecallWithReceipt(next, { issue: "defer" });
  const winnerId = acknowledge(aWinner);
  expect(() => acknowledge(aLoser)).toThrow("stale prepared Recall delivery");
  const replay = runConditionalFieldRecallWithReceipt(next);
  expect(replay.index.page_purpose).toBe("retry");
  expect(replay.index.entries).toEqual(aWinner.index.entries);
  expect(acknowledge(aWinner)).toBe(winnerId);
});
