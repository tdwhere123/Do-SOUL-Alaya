import { describe, expect, it } from "vitest";
import { captureQueryCondition } from
  "../../../../recall/query/condition/query-condition-capture.js";
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
import { fieldContractSha256 } from "../../../../shared/field-hash.js";
import {
  CLOCK_AS_OF,
  conditionDraft
} from "../../query/query-condition-test-fixtures.js";
import { HIDDEN_SCOPE, declaration } from "./fixtures.js";

describe("snapshot hidden universe integration", () => {
  it("keeps public freeze bytes insensitive to restricted hidden sources", () => {
    const { queryCondition, pin, session } = prepareSample();
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
    session.release(pin, CLOCK_AS_OF);
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

function prepareSample() {
  const store = new InMemoryProjectionGenerationStore(fieldContractSha256);
  const session = createSeededTestOnlyInMemoryFieldQuerySessionWithStore(
    fieldContractSha256,
    "workspace-1",
    store
  );
  const pin = session.pinActiveGeneration("workspace-1", CLOCK_AS_OF);
  const queryCondition = captureQueryCondition(conditionDraft(), {
    sha256: fieldContractSha256,
    now: () => CLOCK_AS_OF,
    pin
  });
  return { queryCondition, pin, session };
}
