import { describe, expect, it, vi } from "vitest";
import {
  FieldGenerationEventType,
  MemoryGovernanceEventType
} from "@do-soul/alaya-protocol";
import { SOURCE_PROVENANCE_CAPSULE } from "../../memory/evidence-create/create-evidence.js";
import { createInMemoryFieldStores } from "../../memory/evidence-create/field-stores.js";
import {
  createCreationHarness,
  createEvidenceInput
} from "./evidence-service-fixture.js";

describe("EvidenceService creation", () => {
  it.each([
    { kind: "ordinary source evidence", selection: undefined, sourceRecords: 1 },
    { kind: "source provenance capsule", selection: SOURCE_PROVENANCE_CAPSULE, sourceRecords: 0 }
  ] as const)("preserves source admission role for $kind", async ({ selection, sourceRecords }) => {
    const stores = createInMemoryFieldStores();
    const { service, create } = createCreationHarness({ fieldStores: stores });
    const evidence = await service.create(createEvidenceInput({
      excerpt: "I use Atlas for research.",
      sourceProvenance: selection
    }));
    expect(create).toHaveBeenCalledWith(evidence, [], selection === SOURCE_PROVENANCE_CAPSULE);
    expect(stores.listRecords("workspace-1")).toHaveLength(sourceRecords);
  });

  it("keeps validation and the transactional source guard on provenance capsule creation", async () => {
    const { service, create, append } = createCreationHarness();
    const assertSourceCurrent = vi.fn(() => { throw new Error("source is no longer current"); });
    await expect(service.create(createEvidenceInput({ evidence_kind: "invalid" as never,
      assertSourceCurrent, sourceProvenance: SOURCE_PROVENANCE_CAPSULE })))
      .rejects.toMatchObject({ code: "VALIDATION" });
    expect(assertSourceCurrent).not.toHaveBeenCalled();
    await expect(service.create(createEvidenceInput({ assertSourceCurrent,
      sourceProvenance: SOURCE_PROVENANCE_CAPSULE }))).rejects.toThrow("source is no longer current");
    expect(assertSourceCurrent).toHaveBeenCalledOnce();
    expect(append).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("drops caller-authored fact keys without losing the root evidence", async () => {
    const warn = vi.fn();
    const { service, create, append } = createCreationHarness({ warn });

    const created = await service.create(createEvidenceInput(), [{
      projection_id: 1,
      projection_kind: "fact_key",
      content: "unsealed key"
    }]);

    expect(append.mock.calls.map(([event]) => event.event_type)).toEqual([
      MemoryGovernanceEventType.SOUL_EVIDENCE_CREATED,
      FieldGenerationEventType.SOUL_FIELD_SOURCE_RECORD_ADMITTED
    ]);
    expect(create).toHaveBeenCalledWith(
      created,
      [],
      false
    );
    expect(warn).toHaveBeenCalledWith(
      "optional evidence search projections rejected",
      expect.objectContaining({ evidence_object_id: created.object_id })
    );
  });
});
