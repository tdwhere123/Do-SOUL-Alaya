import { describe, expect, it } from "vitest";
import {
  SnapshotReadLeaseError,
  bindSnapshotReadLease,
  createSnapshotVectorV1,
  finalizeSnapshotReadLease,
  openSnapshotReadLease,
  readSnapshotLeaseCapability,
  releaseSnapshotReadLease,
  type SnapshotReadLeaseViewKind,
  type SnapshotVectorV1,
  type SourceFrontierDeclarationV1
} from "../../../../recall/runtime/snapshot-coherence/index.js";
import {
  AS_OF,
  PRINCIPAL,
  SCOPE,
  declaration,
  exactVectorInput,
  remainingEffect
} from "./fixtures.js";

describe("SnapshotReadLeaseV1", () => {
  it("opens with empty capabilities and a stable lease_id", () => {
    const first = openDefaultLease();
    const second = openDefaultLease();
    expect(first.state).toBe("open");
    expect(first.capabilities).toEqual([]);
    expect(first.vector_digest).toBeNull();
    expect(first.lease_id).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(first.lease_id).toBe(second.lease_id);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it("returns a new frozen lease on bind without mutating the open lease", () => {
    const open = openDefaultLease();
    const vector = createSnapshotVectorV1(exactVectorInput());
    const source = vector.projection_generation;
    const bound = bindSnapshotReadLease(open, {
      source_owner: source.source_owner,
      declaration: source,
      view_kind: "pinned"
    });
    expect(open.capabilities).toEqual([]);
    expect(bound.state).toBe("open");
    expect(bound.capabilities).toHaveLength(1);
    expect(bound.capabilities[0]?.view_kind).toBe("pinned");
    expect(bound.lease_id).toBe(open.lease_id);
    expect(Object.isFrozen(bound)).toBe(true);
    expect(Object.isFrozen(bound.capabilities)).toBe(true);
  });

  it("fails re-bind of the same owner as adapter substitution", () => {
    const vector = createSnapshotVectorV1(exactVectorInput());
    const source = vector.projection_generation;
    const bound = bindSnapshotReadLease(openDefaultLease(), {
      source_owner: source.source_owner,
      declaration: source,
      view_kind: "pinned"
    });
    expectCode("adapter_substitution", () => bindSnapshotReadLease(bound, {
      source_owner: source.source_owner,
      declaration: source,
      view_kind: "captured"
    }));
  });

  it("fails bind after finalize", () => {
    const vector = createSnapshotVectorV1(exactVectorInput());
    const finalized = finalizeSnapshotReadLease(
      bindRequired(openDefaultLease(), vector),
      vector
    );
    expect(finalized.state).toBe("finalized");
    expect(finalized.vector_digest).toBe(vector.vector_digest);
    expectCode("bind_after_finalize", () => bindSnapshotReadLease(finalized, {
      source_owner: "late-owner",
      declaration: declaration({ source_owner: "late-owner" }),
      view_kind: "pinned"
    }));
  });

  it("fails finalize when an exact source owner is unbound", () => {
    const vector = createSnapshotVectorV1(exactVectorInput());
    expectCode("unbound_required_source", () => {
      finalizeSnapshotReadLease(openDefaultLease(), vector);
    });
  });

  it("fails finalize when a bounded source owner is unbound", () => {
    const vector = createSnapshotVectorV1(exactVectorInput({
      embedding_generation_and_model: declaration({
        source_owner: "embedding_generation_and_model",
        lag_bound: {
          kind: "bounded",
          remaining_effect: remainingEffect("embedding_generation_and_model", "embed-lag")
        }
      })
    }));
    const partial = bindSources(
      openDefaultLease(),
      vectorSources(vector).filter((source) => (
        (source.lag_bound.kind === "exact" || source.lag_bound.kind === "bounded")
        && source.source_owner !== "embedding_generation_and_model"
      )),
      () => "pinned"
    );
    expectCode("unbound_required_source", () => {
      finalizeSnapshotReadLease(partial, vector);
    });
  });

  it("fails finalize when vector identity diverges from the lease", () => {
    const vector = createSnapshotVectorV1(exactVectorInput());
    const bound = bindRequired(openDefaultLease(), vector);
    const otherAsOf = createSnapshotVectorV1(exactVectorInput({
      effective_as_of: "2026-07-01T00:00:00.000Z"
    }));
    expectCode("mismatched_principal_scope", () => {
      finalizeSnapshotReadLease(bound, otherAsOf);
    });
  });

  it("reads a bound capability only after finalize", () => {
    const vector = createSnapshotVectorV1(exactVectorInput());
    const bound = bindRequired(openDefaultLease(), vector, "captured");
    expectCode("read_not_finalized", () => {
      readSnapshotLeaseCapability(bound, "projection_generation");
    });
    const finalized = finalizeSnapshotReadLease(bound, vector);
    const capability = readSnapshotLeaseCapability(finalized, "projection_generation");
    expect(capability.source_owner).toBe("projection_generation");
    expect(capability.view_kind).toBe("captured");
    expect(capability.declaration.source_owner).toBe("projection_generation");
  });

  it("fails undeclared capability for an unbound owner", () => {
    const vector = createSnapshotVectorV1(exactVectorInput());
    const finalized = finalizeSnapshotReadLease(
      bindRequired(openDefaultLease(), vector),
      vector
    );
    expectCode("undeclared_capability", () => {
      readSnapshotLeaseCapability(finalized, "not-a-bound-source");
    });
  });

  it("fails read, bind, and finalize after release", () => {
    const vector = createSnapshotVectorV1(exactVectorInput());
    const finalized = finalizeSnapshotReadLease(
      bindRequired(openDefaultLease(), vector),
      vector
    );
    const released = releaseSnapshotReadLease(finalized);
    expect(released.state).toBe("released");
    expect(finalized.state).toBe("finalized");
    expectCode("read_after_release", () => {
      readSnapshotLeaseCapability(released, "projection_generation");
    });
    expectCode("lease_not_open", () => bindSnapshotReadLease(released, {
      source_owner: "late-owner",
      declaration: declaration({ source_owner: "late-owner" }),
      view_kind: "pinned"
    }));
    expectCode("lease_not_open", () => finalizeSnapshotReadLease(released, vector));
  });

  it("returns view_kind unavailable for a bound unavailable view", () => {
    const vector = createSnapshotVectorV1(exactVectorInput({
      embedding_generation_and_model: declaration({
        source_owner: "embedding_generation_and_model",
        lag_bound: { kind: "unavailable" },
        source_frontier: "missing-frontier"
      })
    }));
    const bound = bindSources(openDefaultLease(), vectorSources(vector), (source) => (
      source.source_owner === "embedding_generation_and_model" ? "unavailable" : "pinned"
    ));
    const finalized = finalizeSnapshotReadLease(bound, vector);
    expect(finalized.state).toBe("finalized");
    const capability = readSnapshotLeaseCapability(
      finalized,
      "embedding_generation_and_model"
    );
    expect(capability.view_kind).toBe("unavailable");
    expect(capability.view_kind).not.toBe("pinned");
    expect(capability.view_kind).not.toBe("captured");
  });

  it("fails bind on principal, scope, or source_owner mismatch", () => {
    const vector = createSnapshotVectorV1(exactVectorInput());
    const open = openDefaultLease();
    expectCode("mismatched_principal_scope", () => bindSnapshotReadLease(open, {
      source_owner: "projection_generation",
      declaration: declaration({
        source_owner: "projection_generation",
        principal: "other-principal"
      }),
      view_kind: "pinned"
    }));
    expectCode("mismatched_principal_scope", () => bindSnapshotReadLease(open, {
      source_owner: "projection_generation",
      declaration: declaration({
        source_owner: "projection_generation",
        authorized_scope: "scope-foreign"
      }),
      view_kind: "pinned"
    }));
    expectCode("source_owner_mismatch", () => bindSnapshotReadLease(open, {
      source_owner: "projection_generation",
      declaration: vector.embedding_generation_and_model,
      view_kind: "pinned"
    }));
  });
});

function openDefaultLease() {
  return openSnapshotReadLease({
    principal: PRINCIPAL,
    authorized_scopes: [SCOPE],
    effective_as_of: AS_OF
  });
}

function vectorSources(vector: SnapshotVectorV1): readonly SourceFrontierDeclarationV1[] {
  return [
    vector.projection_generation,
    ...vector.retrieval_channel_snapshots,
    vector.embedding_generation_and_model,
    vector.path_graph_generation,
    vector.temporal_index_generation,
    vector.governance_frontier
  ];
}

function bindRequired(
  lease: ReturnType<typeof openDefaultLease>,
  vector: SnapshotVectorV1,
  viewKind: SnapshotReadLeaseViewKind = "pinned"
) {
  return bindSources(
    lease,
    vectorSources(vector).filter((source) => (
      source.lag_bound.kind === "exact" || source.lag_bound.kind === "bounded"
    )),
    () => viewKind
  );
}

function bindSources(
  lease: ReturnType<typeof openDefaultLease>,
  sources: readonly SourceFrontierDeclarationV1[],
  viewKindFor: (source: SourceFrontierDeclarationV1) => SnapshotReadLeaseViewKind
) {
  let current = lease;
  for (const source of sources) {
    current = bindSnapshotReadLease(current, {
      source_owner: source.source_owner,
      declaration: source,
      view_kind: viewKindFor(source)
    });
  }
  return current;
}

function expectCode(code: string, run: () => unknown): void {
  expect(run).toThrow(SnapshotReadLeaseError);
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SnapshotReadLeaseError);
    expect((error as SnapshotReadLeaseError).code).toBe(code);
  }
}
