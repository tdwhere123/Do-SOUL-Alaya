import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type FieldContractSha256 } from "@do-soul/alaya-protocol";

import {
  createSelectedSliceKeyV2,
  type SelectedSliceKeyInputV2
} from "../../../recall/flood/slice-key-contract.js";
import {
  activateProjectionGeneration,
  buildProjectionGeneration,
  catchUpProjectionGeneration,
  pinProjectionReader,
  verifyProjectionGeneration
} from "../../../recall/field/retrieval/projection/generation-lifecycle.js";
import { createProjectionGenerationReceipt } from
  "../../../recall/field/retrieval/projection/generation-identity.js";
import {
  InMemoryProjectionGenerationStore,
  ProjectionPointerCrash
} from "../../../recall/field/retrieval/projection/generation-store.js";
import { createProjectionEraseBarrier } from
  "../../../recall/field/retrieval/projection/generation-erase.js";
import { createProjectionBundleCache } from
  "../../../recall/field/retrieval/projection/bundle-cache.js";

const CLOCK = "2026-08-16T00:00:00.000Z";
const sha256: FieldContractSha256 = (preimage) =>
  createHash("sha256").update(preimage, "utf8").digest("hex");

describe("immutable projection generations", () => {
  it("snapshots a shadow generation and refuses a second generation table or active insert", () => {
    const store = new InMemoryProjectionGenerationStore(sha256);
    const built = buildWorkspaceGeneration(store, "event-1", [entityKey("memory-1")]);

    expect(built.generation.status).toBe("shadow");
    expect(store.snapshot(built.generation)).toEqual(built.generation);
    expect(() => store.snapshot(createProjectionGenerationReceipt({
      workspace_id: "workspace-1",
      input_event_frontier: "event-1",
      governance_frontier: "gov-1",
      status: "active",
      recorded_at: CLOCK
    }, sha256))).toThrow(/pointer swap/u);
    expect(store.readByGenerationIds("workspace-1", [built.generation.generation_id]))
      .toHaveLength(1);
  });

  it("rejects mixed-generation reads and keeps catch-up on a new immutable identity", () => {
    const store = new InMemoryProjectionGenerationStore(sha256);
    const first = buildWorkspaceGeneration(store, "event-1", [entityKey("memory-1")]);
    const second = catchUpProjectionGeneration({
      store,
      sha256,
      workspace_id: "workspace-1",
      source_generation_id: first.generation.generation_id,
      input_event_frontier: "event-2",
      governance_frontier: "gov-1",
      recorded_at: CLOCK,
      events: [{ kind: "slice_key", key: entityKey("memory-2") }]
    });

    expect(second.generation.generation_id).not.toBe(first.generation.generation_id);
    expect(second.postings.some((posting) => posting.member_ref === "memory-2")).toBe(true);
    expect(store.readArtifacts("workspace-1", first.generation.generation_id)?.postings
      .some((posting) => posting.member_ref === "memory-2")).toBe(false);
    expect(() => store.readByGenerationIds("workspace-1", [
      first.generation.generation_id,
      second.generation.generation_id
    ])).toThrow(/mixed generation/u);
  });

  it("activates only by pointer swap and preserves a pinned reader across cutover", () => {
    const store = new InMemoryProjectionGenerationStore(sha256);
    const first = buildAndVerify(store, "event-1", [entityKey("memory-1")]);
    activateProjectionGeneration(store, {
      workspace_id: "workspace-1",
      active_generation_id: first.generation.generation_id,
      activated_at: CLOCK
    });
    const pinned = pinProjectionReader(store, {
      workspace_id: "workspace-1",
      generation_id: first.generation.generation_id,
      pinned_at: CLOCK
    });
    const next = catchUpProjectionGeneration({
      store,
      sha256,
      workspace_id: "workspace-1",
      source_generation_id: first.generation.generation_id,
      input_event_frontier: "event-2",
      governance_frontier: "gov-1",
      recorded_at: CLOCK,
      events: [{ kind: "slice_key", key: entityKey("memory-2") }]
    });
    verifyProjectionGeneration(store, next.generation, sha256);
    activateProjectionGeneration(store, {
      workspace_id: "workspace-1",
      active_generation_id: next.generation.generation_id,
      activated_at: "2026-08-16T01:00:00.000Z"
    });

    expect(store.readActive("workspace-1")?.generation_id)
      .toBe(next.generation.generation_id);
    expect(() => store.persistStatus(
      "workspace-1",
      next.generation.generation_id,
      "retired"
    )).toThrow(/pointer swap/u);
    expect(store.readPinned("workspace-1", first.generation.generation_id)?.status)
      .toBe("retired");
    expect(pinned.readGeneration().generation_id).toBe(first.generation.generation_id);
    expect(pinned.readPostings().map((posting) => posting.member_ref)).toEqual(["memory-1"]);
    expect(pinProjectionReader(store, {
      workspace_id: "workspace-1",
      generation_id: next.generation.generation_id,
      pinned_at: "2026-08-16T01:00:00.000Z"
    }).readPostings().map((posting) => posting.member_ref)).toEqual([
      "memory-1",
      "memory-2"
    ]);
  });

  it("injects crash points around the pointer swap without sleeping", () => {
    const before = new InMemoryProjectionGenerationStore(sha256);
    const first = buildAndVerify(before, "event-1", [entityKey("memory-1")]);
    const second = buildAndVerify(before, "event-2", [entityKey("memory-2")]);
    activateProjectionGeneration(before, {
      workspace_id: "workspace-1",
      active_generation_id: first.generation.generation_id,
      activated_at: CLOCK
    });
    before.armCrash("before_pointer_swap");
    expect(() => activateProjectionGeneration(before, {
      workspace_id: "workspace-1",
      active_generation_id: second.generation.generation_id,
      activated_at: "2026-08-16T01:00:00.000Z"
    })).toThrow(ProjectionPointerCrash);
    expect(before.readActive("workspace-1")?.generation_id)
      .toBe(first.generation.generation_id);

    const after = new InMemoryProjectionGenerationStore(sha256);
    const live = buildAndVerify(after, "event-1", [entityKey("memory-1")]);
    const incoming = buildAndVerify(after, "event-2", [entityKey("memory-2")]);
    after.armCrash("after_pointer_swap");
    expect(() => activateProjectionGeneration(after, {
      workspace_id: "workspace-1",
      active_generation_id: live.generation.generation_id,
      activated_at: CLOCK
    })).toThrow(ProjectionPointerCrash);
    expect(after.readActive("workspace-1")?.generation_id)
      .toBe(live.generation.generation_id);
    after.armCrash("after_pointer_swap");
    expect(() => activateProjectionGeneration(after, {
      workspace_id: "workspace-1",
      active_generation_id: incoming.generation.generation_id,
      activated_at: "2026-08-16T01:00:00.000Z"
    })).toThrow(ProjectionPointerCrash);
    expect(after.readActive("workspace-1")?.generation_id)
      .toBe(incoming.generation.generation_id);
  });

  it("propagates an erase barrier across retained generations and rejects stale cache", () => {
    const store = new InMemoryProjectionGenerationStore(sha256);
    const first = buildAndVerify(store, "event-1", [entityKey("memory-1")]);
    activateProjectionGeneration(store, {
      workspace_id: "workspace-1",
      active_generation_id: first.generation.generation_id,
      activated_at: CLOCK
    });
    const next = catchUpProjectionGeneration({
      store,
      sha256,
      workspace_id: "workspace-1",
      source_generation_id: first.generation.generation_id,
      input_event_frontier: "event-2",
      governance_frontier: "gov-1",
      recorded_at: CLOCK,
      events: [{ kind: "slice_key", key: entityKey("memory-2") }]
    });
    verifyProjectionGeneration(store, next.generation, sha256);
    const cache = createProjectionBundleCache(sha256);
    const bundle = next.bundles[0]!;
    cache.put({
      bundle,
      condition_digest: digest("condition-1"),
      governance_frontier: "gov-1",
      erase_frontier: "erase-0"
    });

    store.erase(createProjectionEraseBarrier({
      workspace_id: "workspace-1",
      barrier_id: "barrier-memory-1",
      generation_id: null,
      subject_kind: "factor",
      subject_id: "memory-1",
      erased_at: CLOCK
    }, sha256));
    cache.invalidateSubject("memory-1");

    expect(store.readArtifacts("workspace-1", first.generation.generation_id)
      ?.postings.find((posting) => posting.subject_id === "memory-1")).toMatchObject({
      erased: true,
      normalized_value: ""
    });
    expect(store.readArtifacts("workspace-1", next.generation.generation_id)
      ?.postings.find((posting) => posting.subject_id === "memory-1")?.erased).toBe(true);
    expect(() => cache.get({
      bundle_id: bundle.bundle_id,
      condition_digest: digest("condition-1"),
      generation_id: next.generation.generation_id,
      governance_frontier: "gov-1",
      erase_frontier: "erase-0"
    })).toThrow(/stale cache/u);
    expect(() => cache.get({
      bundle_id: bundle.bundle_id,
      condition_digest: digest("condition-1"),
      generation_id: next.generation.generation_id,
      governance_frontier: "gov-2",
      erase_frontier: store.eraseFrontier("workspace-1")
    })).toThrow(/stale cache/u);
  });
});

function buildAndVerify(
  store: InMemoryProjectionGenerationStore,
  frontier: string,
  keys: ReturnType<typeof entityKey>[]
) {
  const built = buildWorkspaceGeneration(store, frontier, keys);
  return verifyProjectionGeneration(store, built.generation, sha256);
}

function buildWorkspaceGeneration(
  store: InMemoryProjectionGenerationStore,
  frontier: string,
  keys: ReturnType<typeof entityKey>[]
) {
  return buildProjectionGeneration({
    store,
    sha256,
    workspace_id: "workspace-1",
    input_event_frontier: frontier,
    governance_frontier: "gov-1",
    recorded_at: CLOCK,
    sliceKeys: keys,
    l2Policy: { materialize: true, maxLevel: 2, maxMembers: 8, minMembers: 1 }
  });
}

function entityKey(ownerId: string) {
  return createSelectedSliceKeyV2(entityInput(ownerId));
}

function entityInput(ownerId: string): SelectedSliceKeyInputV2 {
  return {
    workspace_id: "workspace-1",
    owner_id: ownerId,
    dimension: "entity",
    value: "Ada Lovelace",
    authority: "grounded",
    reliability: 1,
    independence_group: `memory:${ownerId}`,
    provenance: { kind: "canonical_entity", source_ref: `entity:${ownerId}` },
    source_version: "projection:1",
    freshness: { state: "fresh", as_of_ms: 1_720_000_000_000 }
  };
}

function digest(value: string) {
  return `sha256:${sha256(value)}`;
}
