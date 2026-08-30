import { describe, expect, it } from "vitest";
import type { SnapshotReadLeaseV1 } from
  "../../../../../recall/runtime/snapshot-coherence/index.js";
import {
  authorityContext,
  createAuthorityContext,
  createRelationalReceipt,
  materializePath,
  pathSubject
} from "./relational-authority-fixtures.js";

type AuthorityContext = ReturnType<typeof createAuthorityContext>;

describe("relational authority exact snapshot lease", () => {
  it("admits the lawful finalized lease reconstructed from the snapshot vector", () => {
    const context = authorityContext();
    const receipt = createRelationalReceipt(context, pathSubject(), {});

    expect(materializePath(context, receipt).outcomes[0])
      .toMatchObject({ status: "observed" });
  });

  it("rejects an extra capability before relational lookup", () => {
    const context = authorityContext();
    const template = context.read_lease.capabilities[0]!;
    const extra = Object.freeze({
      ...template,
      source_owner: "foreign_relational_projection",
      declaration: Object.freeze({
        ...template.declaration,
        source_owner: "foreign_relational_projection"
      })
    });
    const forged = withLease(context, {
      ...context.read_lease,
      capabilities: Object.freeze([...context.read_lease.capabilities, extra])
    });

    expectOutcomeRejected(forged);
  });

  it("rejects a substituted non-selected capability before relational lookup", () => {
    const context = authorityContext();
    const capabilities = context.read_lease.capabilities.map((capability) =>
      capability.source_owner === "relation_assertions"
        ? Object.freeze({ ...capability, view_kind: "unavailable" as const })
        : capability
    );
    const forged = withLease(context, {
      ...context.read_lease,
      capabilities: Object.freeze(capabilities)
    });

    expectOutcomeRejected(forged);
  });

  it("rejects a selected capability with a foreign generation", () => {
    const context = authorityContext();
    const capabilities = context.read_lease.capabilities.map((capability) =>
      capability.source_owner === "path_relations"
        ? Object.freeze({
            ...capability,
            declaration: Object.freeze({
              ...capability.declaration,
              generation: "foreign-generation"
            })
          })
        : capability
    );
    const forged = withLease(context, {
      ...context.read_lease,
      capabilities: Object.freeze(capabilities)
    });

    expectOutcomeRejected(forged);
  });

  it("rejects a foreign lease cloned to look current", () => {
    const current = authorityContext();
    const foreign = createAuthorityContext({ generation: "foreign-generation" });
    const forged = withLease(current, {
      ...foreign.read_lease,
      lease_id: current.read_lease.lease_id,
      vector_digest: current.snapshot_vector.vector_digest
    });

    expectOutcomeRejected(forged);
  });
});

function withLease(
  context: AuthorityContext,
  read_lease: SnapshotReadLeaseV1
): AuthorityContext {
  return Object.freeze({ ...context, read_lease });
}

function expectOutcomeRejected(context: AuthorityContext): void {
  const receipt = createRelationalReceipt(context, pathSubject(), {});
  expect(materializePath(context, receipt).outcomes[0]).toMatchObject({
    status: "malformed",
    contract_code: "snapshot_authority_mismatch"
  });
}
