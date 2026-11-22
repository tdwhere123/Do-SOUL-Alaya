import { describe, expect, it, vi } from "vitest";
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
      throw new Error("root evidence deletion must not run");
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

  it("admits source-only writes with unknown event and validity time", async () => {
    const stores = createInMemoryFieldStores();
    const { service } = createCreationHarness({
      fieldStores: stores,
      sha256: fieldSha256
    });

    const created = await service.create(createEvidenceInput({
      excerpt: "One sentence. Two sentence.",
      event_anchor: null
    }));

    expect(stores.listRecords("workspace-1")).toHaveLength(1);
    expect(stores.listRecords("workspace-1")[0]?.evidence_object_id).toBe(created.object_id);
    expect(stores.listRecords("workspace-1")[0]?.valid_from).toBeNull();
    expect(stores.listSpans("workspace-1").length).toBeGreaterThan(1);
    expect(created.object_id).toBe("85b3671a-d8d8-4848-9e5c-07d0a89f5ae9");
  });

  it("persists UTF-8 byte spans and reconstructs exact multibyte surfaces", async () => {
    const stores = createInMemoryFieldStores();
    const { service } = createCreationHarness({
      fieldStores: stores,
      sha256: fieldSha256
    });
    const source = "甲😀.\n乙.";

    await service.create(createEvidenceInput({ excerpt: source }));

    const native = stores.listSpans("workspace-1")
      .find((span) => span.purpose === "native_structure");
    expect(native).toMatchObject({
      start_offset: 0,
      end_offset: Buffer.byteLength(source, "utf8")
    });
    expect(stores.listSpans("workspace-1").map((span) =>
      Buffer.from(source, "utf8").subarray(span.start_offset, span.end_offset).toString("utf8")
    )).toEqual(expect.arrayContaining([source, "甲😀.", "乙."]));
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

  it("persists root evidence when optional projection planning is invalid", async () => {
    const stores = createInMemoryFieldStores();
    const { service, create } = createCreationHarness({
      fieldStores: stores,
      sha256: fieldSha256
    });

    const created = await service.create(createEvidenceInput({
      excerpt: "Root survives optional planning."
    }), [{
      projection_kind: "fact_key",
      projection_id: 1,
      content: "forbidden external fact key"
    }]);

    expect(await service.findById(created.object_id)).not.toBeNull();
    expect(create).toHaveBeenCalledWith(
      created, [], false
    );
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
