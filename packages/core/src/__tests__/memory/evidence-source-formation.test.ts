import { describe, expect, it, vi } from "vitest";
import { hashDerivationJobId } from "@do-soul/alaya-protocol";
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
    expect(stores.listFactors("workspace-1")).toEqual(expect.arrayContaining([
      expect.objectContaining({ family: "f0", canonical_payload: source }),
      expect.objectContaining({ family: "f0", canonical_payload: "甲😀." }),
      expect.objectContaining({ family: "f0", canonical_payload: "乙." })
    ]));
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

  it("retains source and spans when factor incidence persistence fails", async () => {
    const base = createInMemoryFieldStores();
    const stores = {
      ...base,
      putIncidence: () => {
        throw new Error("incidence persistence failed");
      }
    };
    const { service } = createCreationHarness({
      fieldStores: stores,
      sha256: fieldSha256
    });

    const created = await service.create(createEvidenceInput({
      excerpt: "Atomic source formation."
    }));

    expect(await service.findById(created.object_id)).not.toBeNull();
    expect(base.listRecords("workspace-1")).toHaveLength(1);
    expect(base.listSpans("workspace-1").length).toBeGreaterThan(0);
    expect(base.listFactors("workspace-1")).toEqual([]);
    expect(base.listIncidences("workspace-1")).toEqual([]);
  });

  it("replays factor formation without duplicating descriptors or incidences", async () => {
    const stores = createInMemoryFieldStores();
    const { service } = createCreationHarness({
      fieldStores: stores,
      sha256: fieldSha256,
      generateObjectId: sequentialIds()
    });
    const sourceHash = "sha256:" + "ef".repeat(32);
    const input = createEvidenceInput({ excerpt: "Replayable formation.", source_hash: sourceHash });

    await service.create(input);
    const firstFactorCount = stores.listFactors("workspace-1").length;
    const firstIncidenceCount = stores.listIncidences("workspace-1").length;
    await service.create(input);

    expect(stores.listRecords("workspace-1")).toHaveLength(1);
    expect(stores.listFactors("workspace-1")).toHaveLength(firstFactorCount);
    expect(stores.listIncidences("workspace-1")).toHaveLength(firstIncidenceCount);
  });

  it("does not nominate pending F3 work when no semantic capture exists", async () => {
    const base = createInMemoryFieldStores();
    const stores = {
      ...base,
      putJob: () => {
        throw new Error("no F3 receipt should be written");
      }
    };
    const { service } = createCreationHarness({
      fieldStores: stores,
      sha256: fieldSha256
    });

    const created = await service.create(createEvidenceInput({
      excerpt: "Durable basis survives optional derivation."
    }));

    expect(await service.findById(created.object_id)).not.toBeNull();
    expect(base.listRecords("workspace-1")).toHaveLength(1);
    expect(base.listSpans("workspace-1").length).toBeGreaterThan(0);
    expect(base.listFactors("workspace-1").length).toBeGreaterThan(0);
    expect(base.listIncidences("workspace-1").length).toBeGreaterThan(0);
  });

  it("persists formed F3 lineage as a terminal replayable receipt", async () => {
    const stores = createInMemoryFieldStores();
    const { service, create } = createCreationHarness({
      fieldStores: stores,
      sha256: fieldSha256
    });
    const source = "Atlas supports research.";
    const producer = "structured_open_semantic_factor_v1";

    await service.create(createEvidenceInput({ excerpt: source }), [], undefined, {
      schema_version: 1,
      producer_operator_id: producer,
      source_text: source,
      graph: semanticGraph(source)
    });

    const capture = create.mock.calls[0]?.[3];
    expect(capture?.status).toBe("formed");
    const identity = hashDerivationJobId({
      purpose: "f3_semantic_capture",
      operator_id: producer,
      input_evidence_ids: ["85b3671a-d8d8-4848-9e5c-07d0a89f5ae9"]
    }, fieldSha256);
    expect(stores.getJob("workspace-1", identity)).toMatchObject({
      status: "succeeded",
      operator_id: producer,
      disposition: capture?.capture_digest
    });
    expect(stores.listFactors("workspace-1")).toEqual(expect.arrayContaining([
      expect.objectContaining({ family: "f3", canonical_payload: "atlas" }),
      expect.objectContaining({ family: "f3", canonical_payload: "research" })
    ]));
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
      projection_version: 1,
      normalized_text: "forbidden external fact key",
      payload: {}
    }]);

    expect(await service.findById(created.object_id)).not.toBeNull();
    expect(create).toHaveBeenCalledWith(created, [], expect.anything(), expect.anything());
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

function semanticGraph(_source: string) {
  return {
    schema_version: 1 as const,
    source_kind: "evidence" as const,
    factors: [
      semanticFactor("atlas", "Atlas", "atlas"),
      semanticFactor("research", "research", "research")
    ],
    variables: [],
    result_variable_ids: [],
    propositions: [{
      proposition_id: "supports-research",
      predicate_factor_id: "research",
      arguments: [{
        position: 0,
        binding_identity: "subject",
        reference_kind: "factor" as const,
        reference_id: "atlas"
      }]
    }]
  };
}

function semanticFactor(
  factorId: string,
  surface: string,
  semanticIdentity: string
) {
  return {
    factor_id: factorId,
    surface,
    source_occurrence: 0,
    semantic_identity: semanticIdentity
  };
}
