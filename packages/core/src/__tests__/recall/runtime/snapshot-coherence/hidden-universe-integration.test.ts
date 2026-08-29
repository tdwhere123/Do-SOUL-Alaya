import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareRecallRequest } from
  "../../../../recall/runtime/query/prepare-recall-request.js";
import { captureRecallRequestTime } from
  "../../../../recall/runtime/query/recall-request-time.js";
import { createSeededTestOnlyInMemoryFieldQuerySessionWithStore } from
  "../../../../recall/runtime/query/field-query-session.js";
import { InMemoryProjectionGenerationStore } from
  "../../../../recall/field/retrieval/projection/generation-store.js";
import {
  SnapshotCoherenceContractError,
  capturePreparedSnapshotCoherenceReceipt,
  publicSnapshotCoherenceReceiptBytes,
  type SourceFrontierDeclarationV1
} from "../../../../recall/runtime/snapshot-coherence/index.js";
import { buildRecallPolicy } from "../../../../shared/recall-policy.js";
import { fieldContractSha256 } from "../../../../shared/field-hash.js";
import { CLOCK_AS_OF } from "../../query/query-condition-test-fixtures.js";
import {
  createDependencies,
  createTaskSurface
} from "../../recall-service-test-fixtures.js";
import { HIDDEN_SCOPE, declaration } from "./fixtures.js";

describe("snapshot hidden universe integration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps public freeze bytes insensitive to restricted hidden sources", async () => {
    const { prepared } = await prepareSample();
    const queryCondition = prepared.queryCondition;
    const pin = prepared.projectionPin;
    const principal = queryCondition.condition.principal;
    const first = capturePreparedSnapshotCoherenceReceipt({
      queryCondition,
      pin,
      restricted_universe: {
        sources: [hiddenSource("hidden-store-a", principal, "hidden-a")]
      }
    });
    const second = capturePreparedSnapshotCoherenceReceipt({
      queryCondition,
      pin,
      restricted_universe: {
        sources: [hiddenSource("hidden-store-b", principal, "hidden-b", "hidden-frontier")]
      }
    });
    const publicBytes = publicSnapshotCoherenceReceiptBytes(first);
    expect(publicBytes).toBe(publicSnapshotCoherenceReceiptBytes(second));
    expect(publicBytes).not.toContain("hidden-store-a");
    expect(publicBytes).not.toContain("hidden-store-b");
    expect(publicBytes).not.toContain("hidden-frontier");
    const authorizedScope = queryCondition.condition.authorized_scopes[0];
    if (authorizedScope === undefined) {
      throw new Error("prepared condition missing authorized scope");
    }
    expect(() => capturePreparedSnapshotCoherenceReceipt({
      queryCondition,
      pin,
      restricted_universe: {
        sources: [declaration({
          source_owner: "hidden-leak-scope",
          principal,
          authorized_scope: authorizedScope
        })]
      }
    })).toThrow(SnapshotCoherenceContractError);
    prepared.releaseProjectionPin();
    prepared.projectionPinLease.stop();
  });
});

function hiddenSource(
  owner: string,
  principal: string,
  generation: string,
  sourceFrontier = generation
): SourceFrontierDeclarationV1 {
  return declaration({
    source_owner: owner,
    principal,
    authorized_scope: HIDDEN_SCOPE,
    generation,
    source_frontier: sourceFrontier
  });
}

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
  return { prepared };
}
