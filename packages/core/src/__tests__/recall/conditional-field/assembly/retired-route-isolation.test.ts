import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryDimension, ScopeClass, StorageTier, type InformationIndex } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "@do-soul/alaya-storage";
import { RecallService, capableRecallConsumerDeclaration } from "../../../../recall/recall-service.js";
import { createDependencies, createSourceBoundRecallFixture, createTaskSurface } from "../../recall-service-test-fixtures.js";
import { plantDeployment, readersFor } from "../../conditional-field-oracle/bound-producer.js";
import { MEM, openSourceSlice } from "../../conditional-field/vertical/source-slice.js";

const databases = new Set<StorageDatabase>();
const QUERY = "materialization routing";
const request = { workspaceId: "workspace-1", strategy: "analyze" as const,
  taskSurface: { ...createTaskSurface(), display_name: QUERY }, queryText: QUERY,
  ...capableRecallConsumerDeclaration() };
const objectId = (number: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(number).padStart(12, "0")}`;

afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases) database.close();
  databases.clear();
});

describe("conditional Recall after retired route removal", () => {
  it("returns real sources without providers, extraction, synthesis, or durable writes", async () => {
    const fixture = await createSourceBoundRecallFixture((database) => databases.add(database));
    const id = objectId(701);
    await fixture.writeSource({ objectId: id, content: QUERY });
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Recall network access forbidden"));
    const nativeLexical = fixture.dependencies.observerReaders?.lexical;
    if (nativeLexical === undefined) throw new Error("fixture must bind the native lexical reader");
    const lexical = vi.fn(nativeLexical);
    const service = new RecallService({
      ...fixture.dependencies,
      observerReaders: { ...fixture.dependencies.observerReaders, lexical }
    });
    const base = service.buildDefaultPolicy("analyze", request.taskSurface.runtime_id);
    const policyOverride = { ...base, coarse_filter: { ...base.coarse_filter,
      semantic_supplement: { ...base.coarse_filter.semantic_supplement,
        enabled: true, embedding_enabled: true, injection_cap: 50 } } };
    const before = fixture.database.connection.prepare("SELECT total_changes() AS count").get();
    const gardenBefore = fixture.pendingGarden();
    let entries: InformationIndex["entries"] | undefined;
    for (const [diagnosticCapture, deliveryPath] of [
      [undefined, undefined], ["answer_features", "legacy"], ["packet_trace", "canonical"]
    ] as const) {
      const result = await service.recall({ ...request, diagnosticCapture, policyOverride: {
        ...policyOverride, fine_assessment: { ...policyOverride.fine_assessment,
          ...(deliveryPath === undefined ? {} : { delivery_path: deliveryPath }) }
      } });
      expect(result.index.entries.map((entry) => entry.object_id)).toContain(id);
      expect(result.candidates.map((entry) => entry.object_id)).toEqual(
        result.index.entries.map((entry) => entry.object_id)
      );
      expect(result.synthesis).toEqual({ status: "absent" });
      expect(result.diagnostics).toBeUndefined();
      expect(result.capture_execution).toBeUndefined();
      expect(result.ranking_authority).toBeUndefined();
      expect(result.provider_calls).toBe(0);
      expect(result.garden_enqueue).toBe(0);
      if (entries === undefined) entries = result.index.entries;
      else expect(result.index.entries).toEqual(entries);
    }
    expect(lexical).toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
    expect(fixture.database.connection.prepare("SELECT total_changes() AS count").get()).toEqual(before);
    expect(fixture.pendingGarden()).toEqual(gardenBefore);
  });

  it("filters actual source scope, dimension, and domain without extracting entity seeds", async () => {
    const fixture = await createSourceBoundRecallFixture((database) => databases.add(database));
    const allowed = objectId(711);
    await fixture.writeSource({ objectId: allowed, content: QUERY,
      dimension: MemoryDimension.FACT, scopeClass: ScopeClass.PROJECT, domainTags: ["routing"] });
    await fixture.writeSource({ objectId: objectId(712), content: QUERY,
      dimension: MemoryDimension.EPISODE, domainTags: ["routing"] });
    await fixture.writeSource({ objectId: objectId(713), content: QUERY,
      dimension: MemoryDimension.FACT, scopeClass: ScopeClass.GLOBAL_DOMAIN, domainTags: ["routing"] });
    await fixture.writeSource({ objectId: objectId(714), content: QUERY,
      dimension: MemoryDimension.FACT, domainTags: ["other"] });
    const unfiltered = await fixture.service.recall(request);
    expect(unfiltered.index.entries.length).toBeGreaterThan(1);
    const base = fixture.service.buildDefaultPolicy("analyze", request.taskSurface.runtime_id);
    const result = await fixture.service.recall({ ...request, policyOverride: {
      ...base, coarse_filter: { ...base.coarse_filter, deterministic_match: {
        ...base.coarse_filter.deterministic_match,
        scope_filter: [ScopeClass.PROJECT], dimension_filter: [MemoryDimension.FACT],
        domain_tag_filter: ["routing"]
      } }
    } });
    expect(result.index.entries.map((entry) => entry.object_id)).toEqual([allowed]);
  });

  it("pages all eligible tiers without a hidden HOT threshold or tier cascade", async () => {
    const fixture = await createSourceBoundRecallFixture((database) => databases.add(database));
    const ids: string[] = [];
    for (const [index, tier] of [StorageTier.HOT, StorageTier.HOT, StorageTier.HOT,
      StorageTier.WARM, StorageTier.COLD].entries()) {
      const id = objectId(721 + index);
      ids.push(id);
      await fixture.writeSource({ objectId: id, content: `${QUERY} source ${index}` });
      fixture.database.connection.prepare("UPDATE memory_entries SET storage_tier = ? WHERE object_id = ?")
        .run(tier, id);
    }
    const full = await fixture.service.recall({ ...request, pageBudget: 100 });
    expect(new Set(full.index.entries.map((entry) => entry.object_id))).toEqual(new Set(ids));
    const pages: InformationIndex[] = [];
    let continuation: InformationIndex["continuation"] = null;
    for (let step = 0; step < 10; step += 1) {
      const page = await fixture.service.recall({ ...request, pageBudget: 1, continuation });
      expect(page.index.entries.length).toBeLessThanOrEqual(1);
      pages.push(page.index);
      continuation = page.index.continuation;
      if (continuation === null) break;
    }
    expect(pages[0]?.continuation).not.toBeNull();
    expect(continuation).toBeNull();
    expect(pages.flatMap((page) => page.entries).map((entry) => entry.object_id)).toEqual(
      full.index.entries.map((entry) => entry.object_id)
    );
  });

  it("extra irrelevant routing edges do not change members or touch fetch/Garden", async () => {
    const slice = await openSourceSlice((database) => databases.add(database));
    await plantDeployment(slice);
    const { dependencies } = createDependencies();
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Recall network access forbidden"));
    const service = new RecallService({
      ...dependencies,
      observerReaders: readersFor(slice)
    });
    const deployed = {
      workspaceId: "workspace-1",
      strategy: "analyze" as const,
      taskSurface: { ...createTaskSurface(), display_name: "yesterday failed deployment" },
      queryText: "yesterday failed deployment",
      pageBudget: 800,
      ...capableRecallConsumerDeclaration()
    };
    const before = await service.recall(deployed);
    await slice.admitRelation({
      evidenceId: "bbbbbbbb-bbbb-4bbb-8bbb-000000000401",
      assertionId: "assert-c-u-route",
      sourceId: MEM.c,
      targetId: MEM.u,
      resultObjectId: MEM.u,
      relationKind: "uses_service",
      validity: { kind: "open", valid_from: "2026-01-01T00:00:00.000Z" },
      gist: "irrelevant routing"
    });
    const gardenBefore = slice.pendingGarden();
    const writesBefore = slice.database.connection.prepare("SELECT total_changes() AS count").get();
    const after = await service.recall(deployed);
    expect(after.index.entries.map((entry) => [
      entry.hypothesis_id, entry.output_binding, entry.object_id, entry.program_state ?? "", entry.time_state ?? ""
    ].join("\0"))).toEqual(before.index.entries.map((entry) => [
      entry.hypothesis_id, entry.output_binding, entry.object_id, entry.program_state ?? "", entry.time_state ?? ""
    ].join("\0")));
    expect(after.index.entries.map((entry) => entry.object_id)).not.toContain(MEM.u);
    expect(after.provider_calls).toBe(0);
    expect(after.garden_enqueue).toBe(0);
    expect(after.ranking_authority).toBeUndefined();
    expect(network).not.toHaveBeenCalled();
    expect(slice.pendingGarden()).toEqual(gardenBefore);
    expect(slice.database.connection.prepare("SELECT total_changes() AS count").get()).toEqual(writesBefore);
  });
});
