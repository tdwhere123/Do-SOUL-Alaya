import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteFieldSourceRecordRepo, type StorageDatabase } from "@do-soul/alaya-storage";
import {
  encodeRecallResult,
  runConditionalFieldRecall
} from "../../../recall/recall-service.js";
import { fieldSha256, hashedRecord } from "../../../../../storage/src/__tests__/repos/field/field-contract-fixture.js";
import {
  FAR_FUTURE_EXPIRY,
  INTERPRETATION_CLOCK,
  SNAPSHOT_ID,
  defaultBudget
} from "../conditional-field/reference/deployment.fixture.js";
import { WS, openSourceSlice } from "../conditional-field/vertical/source-slice.js";
import { readersFor } from "./bound-producer.js";

const databases = new Set<StorageDatabase>();
afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases) database.close();
  databases.clear();
});

describe("CP11 zero live provider and Garden", () => {
  it("source-only runConditionalFieldRecall does not call fetch or enqueue Garden", async () => {
    const slice = await openSourceSlice((database) => databases.add(database));
    new SqliteFieldSourceRecordRepo(slice.database, fieldSha256)
      .insert(hashedRecord(WS, "NEEDLE retained source"));
    const network = vi.spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Recall network access forbidden"));
    const gardenBefore = slice.pendingGarden();
    const index = runConditionalFieldRecall({
      workspace_id: WS,
      query_text: "NEEDLE",
      budget: defaultBudget(),
      snapshot_id: SNAPSHOT_ID,
      interpretation_clock: INTERPRETATION_CLOCK,
      as_of: INTERPRETATION_CLOCK,
      expires_at: FAR_FUTURE_EXPIRY,
      result_kind_view: "source_only",
      authorized_scopes: null,
      readers: readersFor(slice)
    });
    const encoded = encodeRecallResult(index);
    expect(index.entries.some((entry) => entry.target.kind === "source_evidence")).toBe(true);
    expect(encoded.provider_calls).toBe(0);
    expect(encoded.garden_enqueue).toBe(0);
    expect(slice.pendingGarden()).toEqual(gardenBefore);
    expect(network).not.toHaveBeenCalled();
  });
});
