import { afterEach, describe, expect, it, vi } from "vitest";
import { InformationIndexSchema } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "@do-soul/alaya-storage";
import { openBoundSlice, plantDeployment, readersFor, runRecall } from
  "../../../../../../packages/core/src/__tests__/recall/conditional-field-oracle/bound-producer.js";
import { MEM, WS } from
  "../../../../../../packages/core/src/__tests__/recall/conditional-field/vertical/source-slice.js";

const databases = new Set<StorageDatabase>();
afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
  vi.unstubAllEnvs();
});

describe("conditional-field persisted relation integration", () => {
  it("carries admitted relation evidence into a typed associated index without a legacy rank trace", async () => {
    const slice = await openBoundSlice((database) => databases.add(database));
    await plantDeployment(slice);
    const relation = slice.relationReader.read(WS, MEM.r, "observed_log", 16);
    expect(relation.observations).toHaveLength(1);
    expect(relation.observations[0]).toMatchObject({
      sourceObjectId: MEM.r, targetObjectId: MEM.l, predicate: "observed_log",
      validity: { kind: "open" },
      evidenceRefs: expect.arrayContaining([expect.any(String)])
    });
    const index = InformationIndexSchema.parse(runRecall(slice));
    const config = index.entries.find((entry) => entry.object_id === MEM.c && entry.association_milligrades === 1000);
    expect(config).toMatchObject({ claim: "supported", association_milligrades: 1000 });
    expect(config?.explanation_ids.length).toBeGreaterThan(0);
    const explanationIds = new Set(index.explanations?.map((explanation) => explanation.derivation_id));
    expect(config?.explanation_ids.every((id) => explanationIds.has(id))).toBe(true);
    expect(JSON.stringify(index)).not.toContain("flood_potential");
    expect(JSON.stringify(index)).not.toContain("ranking_authority");
  });

  it("keeps legacy slice switches from changing the target field interpretation", async () => {
    const slice = await openBoundSlice((database) => databases.add(database));
    await plantDeployment(slice);
    const baseline = runRecall(slice);
    vi.stubEnv("ALAYA_RECALL_CONF_SLICE_COMPATIBILITY", "on");
    expect(runRecall(slice)).toEqual(baseline);
    vi.stubEnv("ALAYA_RECALL_CONF_SLICE_COMPATIBILITY", "off");
    expect(runRecall(slice)).toEqual(baseline);
  });

  it("does not turn an unavailable native relation reader into complete support", async () => {
    const slice = await openBoundSlice((database) => databases.add(database));
    await plantDeployment(slice);
    const index = InformationIndexSchema.parse(runRecall(slice, {
      readers: { ...readersFor(slice), relation: undefined }
    }));
    expect(index.completeness.logical_index).not.toBe("complete");
    expect(index.entries.some((entry) => entry.object_id === MEM.c)).toBe(false);
  });
});
