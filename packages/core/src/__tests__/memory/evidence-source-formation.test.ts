import { describe, expect, it, vi } from "vitest";
import type { OpenSemanticFactorExtractionPort } from
  "../../semantic/open-semantic-factor-extraction-port.js";
import { fieldContractSha256 as fieldSha256 } from "../../shared/field-hash.js";
import { createInMemoryFieldStores } from "../../memory/evidence-create/field-stores.js";
import { createSourceAdmissionPort } from "../../memory/evidence-create/source-admission.js";
import { createCreationHarness, createEvidenceInput } from "./evidence-service-fixture.js";

describe("EvidenceService source formation", () => {
  it("persists root evidence when optional formation fails and never deletes it", async () => {
    const stores = createInMemoryFieldStores();
    const sourceAdmission = createSourceAdmissionPort({
      sha256: fieldSha256,
      stores,
      admitHook: () => {
        throw new Error("optional formation exploded");
      }
    });
    const deleteById = vi.fn(async () => {
      throw new Error("deleteCreatedEvidence must not run");
    });
    const { service, create } = createCreationHarness({
      sourceAdmission,
      fieldStores: stores,
      sha256: fieldSha256,
      deleteById
    });

    const created = await service.create(createEvidenceInput({
      excerpt: "Raw source with no complete form.",
      event_anchor: null
    }));

    expect(created.excerpt).toBe("Raw source with no complete form.");
    expect(create).toHaveBeenCalled();
    expect(deleteById).not.toHaveBeenCalled();
    expect(stores.listRecords("workspace-1")).toHaveLength(0);
    expect(await service.findById(created.object_id)).not.toBeNull();
  });

  it("admits source-only writes with empty semantics, unknown time, and zero provider calls", async () => {
    const extractor = {
      operator_id: "structured_open_semantic_factor_v1",
      extract: vi.fn(async () => {
        throw new Error("provider must not run");
      })
    } satisfies OpenSemanticFactorExtractionPort;
    const stores = createInMemoryFieldStores();
    const { service, create } = createCreationHarness({
      fieldStores: stores,
      sha256: fieldSha256,
      semanticExtractor: extractor
    });

    const created = await service.create(createEvidenceInput({
      excerpt: "One sentence. Two sentence.",
      event_anchor: null
    }));

    expect(create.mock.calls[0]?.[2]).toMatchObject({ status: "unavailable" });
    expect(create.mock.calls[0]?.[3]).toMatchObject({
      status: "unavailable",
      graph: null
    });
    expect(extractor.extract).not.toHaveBeenCalled();
    expect(stores.listRecords("workspace-1")).toHaveLength(1);
    expect(stores.listRecords("workspace-1")[0]?.evidence_object_id).toBe(created.object_id);
    expect(stores.listRecords("workspace-1")[0]?.valid_from).toBeNull();
    expect(stores.listSpans("workspace-1").length).toBeGreaterThan(1);
    expect(stores.listIncidences("workspace-1").some((row) => {
      return stores.listFactors("workspace-1").some((factor) =>
        factor.identity === row.factor_id && factor.family === "f0"
      );
    })).toBe(true);
    expect(created.object_id).toBe("85b3671a-d8d8-4848-9e5c-07d0a89f5ae9");
  });

  it("replays same-lineage admission and keeps independent sources distinct", async () => {
    const stores = createInMemoryFieldStores();
    const { service } = createCreationHarness({
      fieldStores: stores,
      sha256: fieldSha256,
      generateObjectId: sequentialIds()
    });
    const sharedHash = "sha256:" + "ab".repeat(32);

    await service.create(createEvidenceInput({
      excerpt: "Shared observation.",
      source_hash: sharedHash
    }));
    await service.create(createEvidenceInput({
      excerpt: "Shared observation.",
      source_hash: sharedHash
    }));
    await service.create(createEvidenceInput({
      excerpt: "Shared observation.",
      source_hash: "sha256:" + "cd".repeat(32)
    }));

    const records = stores.listRecords("workspace-1");
    expect(records).toHaveLength(2);
  });
});

function sequentialIds(): () => string {
  let index = 0;
  const ids = [
    "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9",
    "95b3671a-d8d8-4848-9e5c-07d0a89f5ae9",
    "a5b3671a-d8d8-4848-9e5c-07d0a89f5ae9"
  ];
  return () => {
    const id = ids[index];
    index += 1;
    if (id === undefined) {
      throw new Error("test object id exhausted");
    }
    return id;
  };
}
