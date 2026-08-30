import { afterEach, describe, expect, it, vi } from "vitest";
import * as fineAssessment from "../../../../recall/delivery/fine-assessment.js";
import * as gamma from "../../../../recall/delivery/select-gamma/select-gamma.js";
import { captureQueryCondition } from
  "../../../../recall/query/condition/query-condition-capture.js";
import { prepareRecallRequest } from
  "../../../../recall/runtime/query/prepare-recall-request.js";
import { captureRecallRequestTime } from
  "../../../../recall/runtime/query/recall-request-time.js";
import {
  SEALED_EMPTY_FRONTIER,
  createSeededTestOnlyInMemoryFieldQuerySessionWithStore
} from "../../../../recall/runtime/query/field-query-session.js";
import { InMemoryProjectionGenerationStore } from
  "../../../../recall/field/retrieval/projection/generation-store.js";
import {
  activateProjectionGeneration,
  buildProjectionGeneration,
  verifyProjectionGeneration
} from "../../../../recall/field/retrieval/projection/generation-lifecycle.js";
import {
  PREPARE_RETRIEVAL_CHANNEL_OWNERS,
  SnapshotCoherenceContractError,
  SnapshotReadLeaseError,
  bindSnapshotReadLease,
  capturePreparedSnapshotCoherenceReceipt,
  readSnapshotLeaseCapability,
  unavailableProducerDigest
} from "../../../../recall/runtime/snapshot-coherence/index.js";
import { stableStringify } from "../../../../shared/stable-stringify.js";
import { buildRecallPolicy } from "../../../../shared/recall-policy.js";
import { fieldContractSha256 } from "../../../../shared/field-hash.js";
import {
  CLOCK_AS_OF,
  OTHER_GENERATION_ID,
  conditionDraft,
  testPin,
  testSha256
} from "../../query/query-condition-test-fixtures.js";
import {
  runYogaNeutralityBundle,
  stringifyNeutralityRun
} from "../../neutrality-shadow-fixture.js";
import { captureShadowOffBundle } from "../../neutrality-shadow-off-runner.js";
import {
  createDependencies,
  createTaskSurface
} from "../../recall-service-test-fixtures.js";

const SHA_A = `sha256:${"a".repeat(64)}`;

describe("snapshot freeze integration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("captures an unavailable receipt at prepare without changing public delivery", async () => {
    const { prepared, session, store } = await prepareSample();
    expect(prepared.snapshotCoherenceReceipt.coherence_state).toBe("unavailable");
    expect(prepared.snapshotCoherenceReceipt.reasons).toContain("source_unavailable");
    expect(prepared.snapshotCoherenceReceipt.reasons).not.toContain("retrieval_undeclared");
    expect(prepared.snapshotCoherenceReceipt.reasons).not.toContain("decision_contract_unknown");
    expect(prepared.canonicalQueryCompilation.snapshot_receipt_digest)
      .toBe(prepared.snapshotCoherenceReceipt.receipt_digest);
    expect(prepared.canonicalQueryCompilation.query_identity.condition_identity)
      .toBe(prepared.queryCondition.identity);
    expect(prepared.canonicalQueryCompilation.query_identity.generation_id)
      .toBe(prepared.queryCondition.generation_id);
    expect(Object.isFrozen(prepared.snapshotCoherenceReceipt)).toBe(true);
    expect(Object.isFrozen(prepared.projectionPin)).toBe(true);
    expect(prepared.snapshotReadLease.state).toBe("finalized");
    expect(prepared.snapshotReadLease.vector_digest)
      .toBe(prepared.snapshotCoherenceReceipt.vector_digest);
    expect(readSnapshotLeaseCapability(prepared.snapshotReadLease, "projection_generation").view_kind)
      .toBe("pinned");
    expect(
      readSnapshotLeaseCapability(prepared.snapshotReadLease, "embedding_generation_and_model").view_kind
    ).toBe("unavailable");
    expect(() => readSnapshotLeaseCapability(prepared.snapshotReadLease, "unbound_live_port"))
      .toThrow(SnapshotReadLeaseError);
    expect(() => bindSnapshotReadLease(prepared.snapshotReadLease, {
      source_owner: "late_capability",
      declaration: {
        source_owner: "late_capability",
        principal: prepared.snapshotReadLease.principal,
        authorized_scope: prepared.snapshotReadLease.authorized_scopes[0]!,
        source_frontier: "unavailable",
        valid_time_domain: { kind: "timeless" },
        generation: "unavailable",
        operator_or_model_version: "unavailable",
        lag_bound: { kind: "unavailable" }
      },
      view_kind: "unavailable"
    })).toThrow(SnapshotReadLeaseError);
    const digest = prepared.snapshotCoherenceReceipt.receipt_digest;
    const originalKeys = prepared.fieldProjectionSelection.candidate_keys;
    const frozenGeneration = prepared.projectionPin.generation_id;
    const frozenArtifacts = store.readArtifacts("workspace-1", frozenGeneration);
    expect(frozenArtifacts).not.toBeNull();
    expect(() => store.putArtifacts("workspace-1", frozenArtifacts!))
      .toThrow(/immutable/u);
    const later = verifyProjectionGeneration(store, buildProjectionGeneration({
      store,
      sha256: fieldContractSha256,
      workspace_id: "workspace-1",
      input_event_frontier: "later-frontier",
      governance_frontier: SEALED_EMPTY_FRONTIER,
      recorded_at: CLOCK_AS_OF,
      sliceKeys: []
    }).generation, fieldContractSha256);
    activateProjectionGeneration(store, {
      workspace_id: "workspace-1",
      active_generation_id: later.generation.generation_id,
      activated_at: CLOCK_AS_OF
    });
    expect(later.generation.generation_id).not.toBe(frozenGeneration);
    const reread = session.selectCandidates(
      prepared.queryCondition,
      prepared.projectionPin,
      CLOCK_AS_OF
    );
    expect(reread.candidate_keys).toEqual(originalKeys);
    const rebuiltFrozen = capturePreparedSnapshotCoherenceReceipt({
      queryCondition: prepared.queryCondition,
      pin: prepared.projectionPin,
      retrieval_channel_owners: PREPARE_RETRIEVAL_CHANNEL_OWNERS
    });
    expect(rebuiltFrozen.receipt_digest).toBe(digest);
    const laterPin = session.pinActiveGeneration("workspace-1", CLOCK_AS_OF);
    expect(laterPin.generation_id).toBe(later.generation.generation_id);
    expect(() => capturePreparedSnapshotCoherenceReceipt({
      queryCondition: prepared.queryCondition,
      pin: laterPin
    })).toThrow(SnapshotCoherenceContractError);
    prepared.releaseProjectionPin();
    expect(() => session.selectCandidates(
      prepared.queryCondition,
      prepared.projectionPin,
      CLOCK_AS_OF
    )).toThrow(/released|missing/u);
    expect(prepared.snapshotCoherenceReceipt.receipt_digest).toBe(digest);
    prepared.projectionPinLease.stop();
  });

  it("is deterministic for the same pinned prepare inputs", async () => {
    const first = await prepareSample();
    const second = await prepareSample();
    expect(first.prepared.snapshotCoherenceReceipt.receipt_digest)
      .toBe(second.prepared.snapshotCoherenceReceipt.receipt_digest);
    first.prepared.releaseProjectionPin();
    first.prepared.projectionPinLease.stop();
    second.prepared.releaseProjectionPin();
    second.prepared.projectionPinLease.stop();
  });

  it("rejects mixed workspace pins and malformed snapshot digests", () => {
    const pin = testPin();
    const receipt = captureQueryCondition(conditionDraft(), {
      sha256: testSha256(),
      now: () => CLOCK_AS_OF,
      pin
    });
    expect(() => capturePreparedSnapshotCoherenceReceipt({
      queryCondition: receipt,
      pin: { ...pin, workspace_id: "workspace-other" }
    })).toThrow(SnapshotCoherenceContractError);
    expect(() => capturePreparedSnapshotCoherenceReceipt({
      queryCondition: receipt,
      pin: { ...pin, generation_id: OTHER_GENERATION_ID }
    })).toThrow(SnapshotCoherenceContractError);
    expect(() => capturePreparedSnapshotCoherenceReceipt({
      queryCondition: receipt,
      pin,
      snapshotDigest: "not-a-digest"
    })).toThrow(SnapshotCoherenceContractError);
    expect(() => capturePreparedSnapshotCoherenceReceipt({
      queryCondition: receipt,
      pin,
      snapshotDigest: unavailableProducerDigest("base_store")
    })).toThrow(expect.objectContaining({ code: "malformed_digest" }));
    const captured = capturePreparedSnapshotCoherenceReceipt({
      queryCondition: receipt,
      pin
    });
    const withStore = capturePreparedSnapshotCoherenceReceipt({
      queryCondition: receipt,
      pin,
      snapshotDigest: SHA_A
    });
    expect(withStore.vector_digest).not.toBe(captured.vector_digest);
    expect(withStore.coherence_state).toBe("unavailable");
  });

  it("releases the pin when post-pin snapshot capture fails", async () => {
    let live = 0;
    const { prepared: seeded, session } = await prepareSample();
    seeded.releaseProjectionPin();
    seeded.projectionPinLease.stop();
    const tracked = {
      ...session,
      pinActiveGeneration(workspaceId: string, recordedAt: string) {
        live += 1;
        return session.pinActiveGeneration(workspaceId, recordedAt);
      },
      release(pin: typeof seeded.projectionPin, releasedAt: string) {
        live -= 1;
        return session.release(pin, releasedAt);
      }
    };
    const { dependencies } = createDependencies([]);
    const taskSurface = createTaskSurface();
    const policy = buildRecallPolicy({
      runtimeId: "00000000-0000-0000-0000-000000000000",
      taskSurfaceId: taskSurface.runtime_id,
      maxResults: 10,
      filters: { scopeFilter: null, dimensionFilter: null, domainTagFilter: null },
      conflictAwareness: false,
      maxTotalTokens: 1_000
    });
    const time = captureRecallRequestTime({ now: () => CLOCK_AS_OF });
    await expect(prepareRecallRequest({
      dependencies,
      warn: () => undefined,
      now: () => CLOCK_AS_OF,
      buildDefaultPolicy: () => policy,
      fieldQuerySession: tracked,
      sha256: fieldContractSha256
    }, {
      taskSurface,
      workspaceId: "workspace-1",
      strategy: "analyze",
      snapshotDigest: "not-a-digest"
    }, time)).rejects.toThrow(SnapshotCoherenceContractError);
    expect(live).toBe(0);
  });

  it("matches f29002ba shadow-off public delivery and embedding traces", async () => {
    const prepareLegacy = vi.spyOn(fineAssessment, "prepareFineAssessment");
    const assess = vi.spyOn(fineAssessment, "fineAssess");
    const gammaWalk = vi.spyOn(gamma, "selectGammaWalk");
    const head = await runYogaNeutralityBundle();
    const shadowOff = captureShadowOffBundle();
    expect(stringifyNeutralityRun(head.miss)).toBe(stringifyNeutralityRun(shadowOff.miss));
    expect(stringifyNeutralityRun(head.hit)).toBe(stringifyNeutralityRun(shadowOff.hit));
    expect(stableStringify(head.miss.public_delivery))
      .toBe(stableStringify(shadowOff.miss.public_delivery));
    expect(stableStringify(head.hit.public_delivery))
      .toBe(stableStringify(shadowOff.hit.public_delivery));
    expect(head.miss.membership).toEqual(shadowOff.miss.membership);
    expect(head.hit.membership).toEqual(shadowOff.hit.membership);
    expect(head.miss.order).toEqual(shadowOff.miss.order);
    expect(head.hit.order).toEqual(shadowOff.hit.order);
    expect(stableStringify(head.miss.receipt))
      .toBe(stableStringify(shadowOff.miss.receipt));
    expect(stableStringify(head.hit.receipt))
      .toBe(stableStringify(shadowOff.hit.receipt));
    expect(head.miss.trace.provider_embed_texts)
      .toEqual(shadowOff.miss.trace.provider_embed_texts);
    expect(head.hit.trace.provider_embed_texts)
      .toEqual(shadowOff.hit.trace.provider_embed_texts);
    expect(head.miss.trace.repo_reads).toEqual(shadowOff.miss.trace.repo_reads);
    expect(head.hit.trace.repo_reads).toEqual(shadowOff.hit.trace.repo_reads);
    expect(head.miss.trace.repo_writes).toEqual(shadowOff.miss.trace.repo_writes);
    expect(head.hit.trace.repo_writes).toEqual(shadowOff.hit.trace.repo_writes);
    expect(prepareLegacy).not.toHaveBeenCalled();
    expect(assess).toHaveBeenCalled();
    expect(gammaWalk).not.toHaveBeenCalled();
  }, 120_000);
});

async function prepareSample() {
  const { dependencies } = createDependencies([]);
  const taskSurface = createTaskSurface();
  const policy = buildRecallPolicy({
    runtimeId: "00000000-0000-0000-0000-000000000000",
    taskSurfaceId: taskSurface.runtime_id,
    maxResults: 10,
    filters: { scopeFilter: null, dimensionFilter: null, domainTagFilter: null },
    conflictAwareness: false,
    maxTotalTokens: 1_000
  });
  const time = captureRecallRequestTime({ now: () => CLOCK_AS_OF });
  const store = new InMemoryProjectionGenerationStore(fieldContractSha256);
  const session = createSeededTestOnlyInMemoryFieldQuerySessionWithStore(
    fieldContractSha256,
    "workspace-1",
    store
  );
  const prepared = await prepareRecallRequest({
    dependencies,
    warn: () => undefined,
    now: () => CLOCK_AS_OF,
    buildDefaultPolicy: () => policy,
    fieldQuerySession: session,
    sha256: fieldContractSha256
  }, {
    taskSurface,
    workspaceId: "workspace-1",
    strategy: "analyze"
  }, time);
  return { prepared, session, store };
}
