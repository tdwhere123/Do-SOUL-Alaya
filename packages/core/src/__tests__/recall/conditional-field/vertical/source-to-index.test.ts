import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  MemoryDimension,
  type Transition
} from "@do-soul/alaya-protocol";
import { type StorageDatabase } from "@do-soul/alaya-storage";
import { mapNativeReaderPage, projectAcceptingIndex } from
  "../../../../recall/conditional-field/reference/accepting-projection.js";
import { bindMaxMinField } from "../../../../recall/conditional-field/reference/bind-max-min.js";
import {
  defaultBudget,
  defaultView,
  productKey
} from "../reference/deployment.fixture.js";
import {
  INAPPLICABLE_KIND,
  MEM,
  NOW,
  STRENGTH_BY_KIND,
  WS,
  openSourceSlice
} from "./source-slice.js";

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) database.close();
  databases.clear();
});

describe("conditional-field SQLite source-to-index slice", () => {
  it("A01 binds last-week config at 850 from retained projections", async () => {
    const slice = await openSourceSlice((database) => databases.add(database));
    await plantDeployment(slice);
    expect(slice.indexProjection.freshness(WS, MEM.c)).toMatchObject({
      lexical: "ready",
      semantic: "pending"
    });
    const lexical = slice.memoryReader.lexical(WS, "failed deployment", 16);
    expect(lexical.ids).toContain(MEM.r);
    const bound = bindObserved(slice);
    const config = bound.snapshot.values.find((value) => value.state.object_id === MEM.c);
    expect(config?.milligrades).toBe(850);
    const index = projectAcceptingIndex({
      snapshot: bound.snapshot,
      view: defaultView(),
      query_id: "failed-deployment",
      snapshot_id: snapshotId(),
      result_version: "v1",
      budget: defaultBudget(),
      roles: deploymentRoles()
    });
    expect(index.entries.find((entry) => entry.object_id === MEM.c)?.association_milligrades)
      .toBe(850);
    expect(bound.snapshot.retained_transitions.some((transition) => transition.to.object_id === MEM.u))
      .toBe(false);
  });

  it("A17 keeps garden enqueue and provider counters at zero during the read", async () => {
    const slice = await openSourceSlice((database) => databases.add(database));
    await plantDeployment(slice);
    expect(slice.pendingGarden()).toHaveLength(0);
    expect(slice.indexProjection.freshness(WS, MEM.r).semantic).toBe("pending");
    const before = slice.pendingGarden().length;
    slice.memoryReader.lexical(WS, "failed deployment", 16);
    slice.relationReader.read(WS, MEM.r, "observed_log", 16);
    expect(slice.pendingGarden()).toHaveLength(before);
    expect(slice.pendingGarden()).toHaveLength(0);
  });

  it("A18 hides a tombstone and keeps the current source after close/reopen", async () => {
    const directory = mkdtempSync(join(tmpdir(), "conditional-field-a18-"));
    const filename = join(directory, "source.sqlite");
    const first = await openSourceSlice((database) => databases.add(database), filename);
    await plantDeployment(first);
    const updateWithinTransaction = first.memoryEntryRepo.updateWithinTransaction;
    if (updateWithinTransaction === undefined) {
      throw new Error("memory update transaction port is required for tombstone");
    }
    updateWithinTransaction.call(first.memoryEntryRepo, MEM.u, {
      retention_state: "tombstoned",
      updated_at: NOW
    }, { beforeUpdate: () => undefined, afterUpdate: () => undefined }, WS);
    expect(first.indexProjection.freshness(WS, MEM.u).lexical).toBe("tombstoned");
    const hidden = bindObserved(first);
    expect(hidden.snapshot.values.some((value) =>
      value.state.object_id === MEM.u && value.milligrades > 0
    )).toBe(false);
    first.database.close();
    databases.delete(first.database);
    const reopened = await openSourceSlice((database) => databases.add(database), filename);
    expect(reopened.indexProjection.freshness(WS, MEM.u).lexical).toBe("tombstoned");
    expect(reopened.memoryReader.source(WS, MEM.r).unavailable).toBe(false);
    expect(reopened.memoryReader.source(WS, MEM.r).row?.object_id).toBe(MEM.r);
    reopened.database.close();
    databases.delete(reopened.database);
    rmSync(directory, { recursive: true, force: true });
  });

  it("A09 maps a truncated native zero-id page to interrupted/open", async () => {
    const slice = await openSourceSlice((database) => databases.add(database));
    await plantDeployment(slice);
    const page = slice.memoryReader.lexical(WS, "failed deployment", 16, 0);
    expect(page.ids).toEqual([]);
    expect(page.truncated).toBe(true);
    const mapped = mapNativeReaderPage({
      ids: page.ids,
      truncated: page.truncated,
      readerAvailable: true
    });
    expect(mapped.outcome.status).toBe("interrupted");
    expect(mapped.open_regions.length).toBeGreaterThan(0);
    expect(mapped.outcome.status).not.toBe("exhausted");
  });

  it("A12 reports empty exhausted versus unavailable coverage", async () => {
    const empty = await openSourceSlice((database) => databases.add(database));
    const page = empty.memoryReader.lexical(WS, "failed deployment", 16);
    expect(page.ids).toEqual([]);
    expect(page.truncated).toBe(false);
    const bound = bindMaxMinField({
      query_id: "failed-deployment",
      snapshot_id: snapshotId(),
      budget: defaultBudget(),
      seeds: [],
      transitions: []
    });
    if (bound.kind !== "bound") throw new Error("expected bound field");
    const exhausted = mapNativeReaderPage({
      ids: page.ids,
      truncated: page.truncated,
      readerAvailable: true
    });
    const emptyIndex = projectAcceptingIndex({
      snapshot: bound.snapshot,
      view: defaultView(),
      query_id: "failed-deployment",
      snapshot_id: snapshotId(),
      result_version: "v1",
      budget: defaultBudget(),
      observer: exhausted
    });
    expect(emptyIndex.completeness.logical_index).toBe("complete");
    expect(emptyIndex.completeness.observed_coverage).toBe("exhausted_empty");
    const unavailable = mapNativeReaderPage({
      ids: [],
      truncated: false,
      readerAvailable: false
    });
    const unavailableIndex = projectAcceptingIndex({
      snapshot: bound.snapshot,
      view: defaultView(),
      query_id: "failed-deployment",
      snapshot_id: snapshotId(),
      result_version: "v1",
      budget: defaultBudget(),
      observer: unavailable
    });
    expect(unavailableIndex.completeness.observed_coverage).toBe("unavailable");
    expect(unavailableIndex.completeness.logical_index).not.toBe("complete");
  });
});

async function plantDeployment(slice: Awaited<ReturnType<typeof openSourceSlice>>) {
  await slice.writeMemory(MEM.r, "yesterday failed deployment of checkout", MemoryDimension.EPISODE);
  await slice.writeMemory(MEM.l, "deployment log for yesterday checkout failure", MemoryDimension.EPISODE);
  await slice.writeMemory(MEM.c, "last-week configuration change for checkout", MemoryDimension.FACT);
  await slice.writeMemory(MEM.s, "shared routing service for checkout", MemoryDimension.FACT);
  await slice.writeMemory(MEM.h, "prior same-service failure last month", MemoryDimension.EPISODE);
  await slice.writeMemory(MEM.u, "unrelated picnic menu", MemoryDimension.FACT);
  const open = { kind: "open" as const, valid_from: "2026-01-01T00:00:00.000Z" };
  await slice.admitRelation({
    evidenceId: "bbbbbbbb-bbbb-4bbb-8bbb-000000000201",
    assertionId: "assert-r-l",
    sourceId: MEM.r,
    targetId: MEM.l,
    resultObjectId: MEM.l,
    relationKind: "observed_log",
    validity: open,
    gist: "log of yesterday failed deployment"
  });
  await slice.admitRelation({
    evidenceId: "bbbbbbbb-bbbb-4bbb-8bbb-000000000202",
    assertionId: "assert-l-c",
    sourceId: MEM.l,
    targetId: MEM.c,
    resultObjectId: MEM.c,
    relationKind: "config_via_log",
    validity: open,
    gist: "config reached through the log"
  });
  await slice.admitRelation({
    evidenceId: "bbbbbbbb-bbbb-4bbb-8bbb-000000000203",
    assertionId: "assert-r-c",
    sourceId: MEM.r,
    targetId: MEM.c,
    resultObjectId: MEM.c,
    relationKind: "config_direct",
    validity: open,
    gist: "direct config association"
  });
  await slice.admitRelation({
    evidenceId: "bbbbbbbb-bbbb-4bbb-8bbb-000000000204",
    assertionId: "assert-r-s",
    sourceId: MEM.r,
    targetId: MEM.s,
    resultObjectId: MEM.s,
    relationKind: "uses_service",
    validity: open,
    gist: "deployment uses shared service"
  });
  await slice.admitRelation({
    evidenceId: "bbbbbbbb-bbbb-4bbb-8bbb-000000000205",
    assertionId: "assert-s-h",
    sourceId: MEM.s,
    targetId: MEM.h,
    resultObjectId: MEM.h,
    relationKind: "service_history",
    validity: open,
    gist: "prior failure on the same service"
  });
  await slice.admitRelation({
    evidenceId: "bbbbbbbb-bbbb-4bbb-8bbb-000000000206",
    assertionId: "assert-r-u",
    sourceId: MEM.r,
    targetId: MEM.u,
    resultObjectId: MEM.u,
    relationKind: INAPPLICABLE_KIND,
    validity: open,
    gist: "inapplicable picnic menu"
  });
}

function bindObserved(slice: Awaited<ReturnType<typeof openSourceSlice>>) {
  const transitions = observedTransitions(slice);
  const bound = bindMaxMinField({
    query_id: "failed-deployment",
    snapshot_id: snapshotId(),
    budget: defaultBudget(),
    seeds: [{
      schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
      state: productKey(MEM.r),
      milligrades: 1000
    }],
    transitions
  });
  if (bound.kind !== "bound") throw new Error("expected bound field");
  return bound;
}

function observedTransitions(slice: Awaited<ReturnType<typeof openSourceSlice>>): Transition[] {
  const kinds = [...Object.keys(STRENGTH_BY_KIND), INAPPLICABLE_KIND];
  const sources = [MEM.r, MEM.l, MEM.s, MEM.c, MEM.h, MEM.u];
  const transitions: Transition[] = [];
  for (const source of sources) {
    if (slice.indexProjection.freshness(WS, source).lexical === "tombstoned") continue;
    for (const kind of kinds) {
      const page = slice.relationReader.read(WS, source, kind, 16);
      for (const observation of page.observations) {
        if (observation.resolutionKind !== null) continue;
        const strength = STRENGTH_BY_KIND[observation.predicate];
        const target = observation.targetObjectId;
        if (strength === undefined) continue;
        if (slice.indexProjection.freshness(WS, target).lexical === "tombstoned") continue;
        transitions.push({
          schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
          from: productKey(observation.sourceObjectId),
          to: productKey(target),
          relation_kind: observation.predicate,
          strength_milligrades: strength,
          validity: observation.validity,
          applicable: true
        });
      }
    }
  }
  return transitions;
}

function deploymentRoles() {
  return new Map([
    [MEM.r, "requested" as const],
    [MEM.l, "associated" as const],
    [MEM.c, "associated" as const],
    [MEM.s, "routing_only" as const],
    [MEM.h, "associated" as const]
  ]);
}

function snapshotId(): string {
  return `sha256:${"d".repeat(64)}`;
}
