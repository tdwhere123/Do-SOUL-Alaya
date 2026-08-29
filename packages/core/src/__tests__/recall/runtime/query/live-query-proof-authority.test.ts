import { describe, expect, it } from "vitest";
import { prepareRecallRequest } from
  "../../../../recall/runtime/query/prepare-recall-request.js";
import { captureRecallRequestTime } from
  "../../../../recall/runtime/query/recall-request-time.js";
import { createSeededTestOnlyInMemoryFieldQuerySession } from
  "../../../../recall/runtime/query/field-query-session.js";
import {
  admitLiveLexicalProofs,
  LiveQueryProofAuthorityError,
  verifyLiveQueryProofAuthority,
  type LiveQueryProofAuthorityFailureCode,
  type LiveQueryProofAuthority
} from "../../../../recall/runtime/query/live-query-proof-authority.js";
import { compileCanonicalQueryCompilation } from
  "../../../../recall/query/canonical-query/index.js";
import type { PreparedRecallRequest } from
  "../../../../recall/runtime/recall-service-runner-types.js";
import { buildDefaultPolicy } from "../../../../recall/runtime/orchestration.js";
import { fieldContractSha256 } from "../../../../shared/field-hash.js";
import { createDependencies, createTaskSurface } from
  "../../recall-service-test-fixtures.js";
import { D1_REQUEST, plantProof } from "../../shadow/d1/d1-proof-fixture.js";

const NOW = "2026-08-29T00:00:00.000Z";
const FOREIGN_REQUEST = `sha256:${"c".repeat(64)}`;
const SECOND_REQUEST = `sha256:${"d".repeat(64)}`;

describe("live query proof prepared authority", () => {
  it("keeps prepared query identity independent of storage-local query_run_id", async () => {
    const prepared = await prepareAuthority();
    const authority = authorityFrom(prepared);
    const first = admitLiveLexicalProofs(authority, [proof(
      "lane-a", D1_REQUEST, prepared.snapshotVector.vector_digest
    )]);
    const second = admitLiveLexicalProofs(authority, [proof(
      "lane-b", D1_REQUEST, prepared.snapshotVector.vector_digest
    )]);

    expect(verifyLiveQueryProofAuthority(authority).query_id)
      .toBe(prepared.queryCondition.identity);
    expect(first?.[0]?.status).toBe("captured");
    expect(second?.[0]?.status).toBe("captured");
    cleanup(prepared);
  });

  it("rejects nonfinal and mismatched snapshot authorities", async () => {
    const prepared = await prepareAuthority();
    const authority = authorityFrom(prepared);
    const baseStoreDigest = prepared.snapshotVector.base_store_digest;

    expect(() => verifyLiveQueryProofAuthority({
      ...authority,
      snapshot_read_lease: { ...authority.snapshot_read_lease, state: "open" }
    })).toThrow(LiveQueryProofAuthorityError);
    expect(() => verifyLiveQueryProofAuthority({
      ...authority,
      snapshot_read_lease: {
        ...authority.snapshot_read_lease,
        lease_id: baseStoreDigest
      }
    })).toThrow(LiveQueryProofAuthorityError);
    expect(() => verifyLiveQueryProofAuthority({
      ...authority,
      snapshot_vector: { ...authority.snapshot_vector, vector_digest: baseStoreDigest }
    })).toThrow();
    expect(() => verifyLiveQueryProofAuthority({
      ...authority,
      snapshot_coherence_receipt: {
        ...authority.snapshot_coherence_receipt,
        vector_digest: baseStoreDigest
      }
    })).toThrow();
    expect(() => verifyLiveQueryProofAuthority({
      ...authority,
      canonical_query_compilation: {
        ...authority.canonical_query_compilation,
        snapshot_receipt_digest: baseStoreDigest
      }
    })).toThrow(LiveQueryProofAuthorityError);
    expect(() => verifyLiveQueryProofAuthority({
      ...authority,
      canonical_query_evidence: {
        ...authority.canonical_query_evidence,
        query_identity: {
          ...authority.canonical_query_evidence.query_identity!,
          condition_identity: "condition-foreign"
        }
      }
    })).toThrow(LiveQueryProofAuthorityError);
    expect(() => verifyLiveQueryProofAuthority({
      ...authority,
      snapshot_read_lease: {
        ...authority.snapshot_read_lease,
        capabilities: []
      }
    })).toThrow(LiveQueryProofAuthorityError);
    cleanup(prepared);
  });

  it("reports closed failure codes without forwarding verifier messages", async () => {
    const prepared = await prepareAuthority();
    const authority = authorityFrom(prepared);
    const foreignEvidence = Object.freeze({
      ...authority.canonical_query_evidence,
      query_identity: Object.freeze({
        ...authority.canonical_query_evidence.query_identity!,
        condition_identity: "condition-foreign"
      })
    });
    const foreignCompilation = compileCanonicalQueryCompilation(
      foreignEvidence,
      authority.snapshot_coherence_receipt
    );
    const baseStoreDigest = prepared.snapshotVector.base_store_digest;
    const cases: readonly [LiveQueryProofAuthorityFailureCode, LiveQueryProofAuthority][] = [
      ["query_condition_invalid", {
        ...authority,
        query_condition: { ...authority.query_condition, identity: "untrusted-marker" }
      } as LiveQueryProofAuthority],
      ["workspace_identity_mismatch", {
        ...authority,
        workspace_id: "workspace-other"
      }],
      ["snapshot_vector_invalid", {
        ...authority,
        snapshot_vector: { ...authority.snapshot_vector, vector_digest: baseStoreDigest }
      }],
      ["snapshot_coherence_invalid", {
        ...authority,
        snapshot_coherence_receipt: {
          ...authority.snapshot_coherence_receipt,
          vector_digest: baseStoreDigest
        }
      }],
      ["canonical_snapshot_receipt_mismatch", {
        ...authority,
        canonical_query_compilation: {
          ...authority.canonical_query_compilation,
          snapshot_receipt_digest: baseStoreDigest
        }
      }],
      ["canonical_query_invalid", {
        ...authority,
        canonical_query_compilation: {
          ...authority.canonical_query_compilation,
          digest: baseStoreDigest
        }
      }],
      ["canonical_query_identity_mismatch", {
        ...authority,
        canonical_query_evidence: foreignEvidence,
        canonical_query_compilation: foreignCompilation
      }],
      ["snapshot_lease_invalid", {
        ...authority,
        snapshot_read_lease: { ...authority.snapshot_read_lease, state: "open" }
      }],
      ["lexical_request_pin_invalid", {
        ...authority,
        expected_lexical_request_pins: [{
          ...authority.expected_lexical_request_pins[0]!,
          request_digest: "untrusted-marker"
        }]
      }]
    ];

    for (const [code, candidate] of cases) {
      expectAuthorityFailure(candidate, code);
    }
    cleanup(prepared);
  });

  it("rejects duplicate, mixed-foreign, missing, workspace, request, and snapshot collections", async () => {
    const prepared = await prepareAuthority();
    const authority = authorityFrom(prepared);
    const twoPinAuthority = Object.freeze({
      ...authority,
      expected_lexical_request_pins: [
        ...authority.expected_lexical_request_pins,
        lexicalPin(SECOND_REQUEST, "lexical_expanded")
      ]
    });
    const valid = proof(
      "lane-valid", D1_REQUEST, prepared.snapshotVector.vector_digest
    );
    const foreign = proof(
      "lane-foreign", FOREIGN_REQUEST, prepared.snapshotVector.vector_digest,
      "workspace-1", "lexical_expanded"
    );
    const wrongSnapshot = proof(
      "lane-wrong-snapshot", D1_REQUEST, prepared.snapshotVector.base_store_digest
    );

    expect(admitLiveLexicalProofs(authority, [])).toBeUndefined();
    expect(admitLiveLexicalProofs(twoPinAuthority, [valid])).toBeUndefined();
    expect(admitLiveLexicalProofs(twoPinAuthority, [valid, valid])).toBeUndefined();
    expect(admitLiveLexicalProofs(twoPinAuthority, [valid, foreign])).toBeUndefined();
    expect(admitLiveLexicalProofs(authority, [foreign])).toBeUndefined();
    expect(admitLiveLexicalProofs(authority, [wrongSnapshot])).toBeUndefined();
    expect(admitLiveLexicalProofs(authority, [proof(
      "lane-wrong-workspace", D1_REQUEST, prepared.snapshotVector.vector_digest,
      "workspace-other"
    )])).toBeUndefined();
    expect(admitLiveLexicalProofs(authority, [proof(
      "lane-unavailable", D1_REQUEST, null
    )])).toBeUndefined();
    cleanup(prepared);
  });
});

function proof(
  queryRunId: string,
  requestDigest = D1_REQUEST,
  snapshotDigest: string | null = null,
  workspaceId = "workspace-1",
  fieldPrefix: "lexical_relaxed" | "lexical_expanded" = "lexical_relaxed"
) {
  return plantProof({
    queryRunId,
    requestDigest,
    snapshotDigest,
    workspaceId,
    fieldPrefix,
    lanes: { porter: { rows: [{ key: "cand-a", ordinal: 0.9 }] } }
  });
}

function authorityFrom(prepared: PreparedRecallRequest): LiveQueryProofAuthority {
  return Object.freeze({
    workspace_id: "workspace-1",
    query_condition: prepared.queryCondition,
    canonical_query_evidence: prepared.canonicalQueryEvidence,
    canonical_query_compilation: prepared.canonicalQueryCompilation,
    snapshot_vector: prepared.snapshotVector,
    snapshot_coherence_receipt: prepared.snapshotCoherenceReceipt,
    snapshot_read_lease: prepared.snapshotReadLease,
    expected_lexical_request_pins: [lexicalPin(D1_REQUEST, "lexical_relaxed")]
  });
}

function lexicalPin(
  requestDigest: `sha256:${string}`,
  fieldPrefix: "lexical_relaxed" | "lexical_expanded"
) {
  return Object.freeze({
    workspace_id: "workspace-1",
    request_digest: requestDigest,
    field_prefix: fieldPrefix,
    candidate_key_domain: "memory_object_id" as const
  });
}

async function prepareAuthority(): Promise<PreparedRecallRequest> {
  const { dependencies } = createDependencies([]);
  return await prepareRecallRequest({
    dependencies,
    warn: () => undefined,
    now: () => NOW,
    buildDefaultPolicy: () => buildDefaultPolicy({
      strategy: "analyze",
      taskSurfaceRef: createTaskSurface().runtime_id,
      now: () => NOW,
      generateRuntimeId: () => "33333333-3333-4333-8333-333333333333"
    }),
    fieldQuerySession: createSeededTestOnlyInMemoryFieldQuerySession(
      fieldContractSha256, "workspace-1"
    ),
    sha256: fieldContractSha256
  }, {
    taskSurface: createTaskSurface(),
    workspaceId: "workspace-1",
    strategy: "analyze"
  }, captureRecallRequestTime({ now: () => NOW }));
}

function cleanup(prepared: PreparedRecallRequest): void {
  prepared.releaseProjectionPin();
  prepared.projectionPinLease.stop();
}

function expectAuthorityFailure(
  authority: LiveQueryProofAuthority,
  code: LiveQueryProofAuthorityFailureCode
): void {
  try {
    verifyLiveQueryProofAuthority(authority);
    throw new Error(`expected authority failure ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(LiveQueryProofAuthorityError);
    expect(error).toMatchObject({
      code,
      message: "live query proof authority verification failed"
    });
    expect((error as Error).message).not.toContain("untrusted-marker");
  }
}
