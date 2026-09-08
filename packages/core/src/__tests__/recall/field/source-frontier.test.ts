import { describe, expect, it } from "vitest";
import { createInMemoryFieldStores } from "../../../memory/evidence-create/field-stores.js";
import { fieldContractSha256 } from "../../../shared/field-hash.js";
import { projectSourceFormationSnapshot } from "../../../recall/field/retrieval/projection/source-projection.js";
import { digestRecallFieldIdentity } from "../../../recall/field/field-identity.js";
import { createCreationHarness, createEvidenceInput } from "../../memory/evidence-service-fixture.js";

async function sourceStores() {
  const stores = createInMemoryFieldStores();
  const { service } = createCreationHarness({ fieldStores: stores, sha256: fieldContractSha256 });
  await service.create(createEvidenceInput({ excerpt: "Alice graduated with a degree. Bob moved to Japan.", event_anchor: null }));
  return stores;
}

describe("conditional field source generation frontier", () => {
  it("pins the same source regardless of persistence enumeration order", async () => {
    const stores = await sourceStores();
    const first = projectSourceFormationSnapshot({ workspaceId: "workspace-1", stores });
    const reordered = {
      ...stores,
      listStoredRecords: (workspaceId: string) => [...stores.listStoredRecords(workspaceId)].reverse(),
      listSpans: (workspaceId: string) => [...stores.listSpans(workspaceId)].reverse(),
      listFactors: (workspaceId: string) => [...stores.listFactors(workspaceId)].reverse(),
      listIncidences: (workspaceId: string) => [...stores.listIncidences(workspaceId)].reverse()
    };
    expect(projectSourceFormationSnapshot({ workspaceId: "workspace-1", stores: reordered })).toEqual(first);
    expect(Object.keys(first)).toEqual(["input_event_frontier"]);
  });

  it("refuses a changed immutable body before a generation can be verified", async () => {
    const stores = await sourceStores();
    const corrupt = {
      ...stores,
      listStoredRecords: (workspaceId: string) => stores.listStoredRecords(workspaceId).map(
        (row) => ({ ...row, content_bytes: `${row.content_bytes} tampered` })
      )
    };
    expect(() => projectSourceFormationSnapshot({ workspaceId: "workspace-1", stores: corrupt }))
      .toThrow("stored source body does not match its immutable digest");
  });

  it("changes identity for binding deletion and cannot reuse the retired projection frontier", async () => {
    const stores = await sourceStores();
    const current = projectSourceFormationSnapshot({ workspaceId: "workspace-1", stores });
    const unbound = projectSourceFormationSnapshot({
      workspaceId: "workspace-1", stores: { ...stores, listRecordEvidenceBindings: () => [] }
    });
    expect(unbound.input_event_frontier).not.toBe(current.input_event_frontier);
    const empty = createInMemoryFieldStores();
    const emptyCurrent = projectSourceFormationSnapshot({ workspaceId: "workspace-1", stores: empty });
    const retired = digestRecallFieldIdentity({ records: [], bindings: [], spans: [], factors: [], incidences: [] });
    expect(emptyCurrent.input_event_frontier).not.toBe(retired);
  });
});
