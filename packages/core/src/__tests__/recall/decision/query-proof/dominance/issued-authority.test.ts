import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ShadowContractError } from
  "../../../../../recall/decision/contract-primitives.js";
import * as compare from
  "../../../../../recall/decision/query-proof/dominance/compare.js";
import {
  issuePsiV2AuthorityArtifact,
  type PsiV2PairOutcomeV1
} from "../../../../../recall/decision/query-proof/dominance/authority.js";
import {
  psiV2CandidateFromLexicalEnvelope,
  type PsiV2CandidateV1
} from "../../../../../recall/decision/query-proof/dominance/index.js";
import type { CurrentMeasurementAuthoritiesV1 } from
  "../../../../../recall/decision/query-proof/measurement/index.js";
import { lexicalIntervalSourceEnvelopes } from
  "../../../../../recall/decision/query-proof/measurement/lexical-interval-envelope.js";
import type { LexicalIntervalSourceReceiptCapturedV1 } from
  "../../../../../recall/field/retrieval/lexical-interval-source-receipt.js";
import type { PreparedRecallRequest } from
  "../../../../../recall/runtime/recall-service-runner-types.js";
import {
  prepareMeasurementEvidenceFixture,
  releaseMeasurementEvidenceFixture,
  withCapturedLexicalMeasurementAuthorityFixture
} from "../measurement/prepared-authority-fixture.js";

const PAIR_DOMAIN: readonly PsiV2PairOutcomeV1[] = [
  "strict_edge", "reverse_edge", "equal", "incomparable", "tradeoff",
  "uncertain", "unsupported"
];

let prepared: PreparedRecallRequest;

describe("issued Psi-v2 authority artifact", () => {
  beforeAll(async () => {
    prepared = await prepareMeasurementEvidenceFixture();
  });

  afterAll(() => releaseMeasurementEvidenceFixture(prepared));

  it("conserves the complete directed pair domain on incomparable candidates", () => {
    const artifact = issuePsiV2AuthorityArtifact({
      query_digest: "sha256:query-incomparable",
      snapshot_digest: "sha256:snap-incomparable",
      workspace_id: "workspace-1",
      candidates: [
        candidate("c-1"),
        candidate("c-2"),
        candidate("c-3")
      ],
      current_authorities: []
    });
    expect(artifact.candidate_universe).toEqual(["c-1", "c-2", "c-3"]);
    expect(artifact.pair_outcomes).toHaveLength(6);
    expect(new Set(artifact.pair_outcomes.map((row) =>
      `${row.left_candidate_key}\0${row.right_candidate_key}`)).size).toBe(6);
    expect(artifact.pair_outcomes.every((row) => PAIR_DOMAIN.includes(row.outcome))).toBe(true);
    expect(artifact.pair_outcomes.every((row) => row.outcome === "incomparable")).toBe(true);
    expect(artifact.cycle_status).toBe("no_cycle");
    expect(artifact.first_frontier_size).toBe(3);
    expect(artifact.frontier_depth).toBe(1);
    expect(artifact.first_frontier_size).not.toBe(artifact.frontier_depth);
    expect(artifact.structural_digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("records exact safe dominance, reverse edges, and equality", async () => {
    await withField([["a", 0.9], ["b", 0.5], ["c", 0.5]], (authority, source) => {
      const artifact = issuePsiV2AuthorityArtifact({
        query_digest: authority.query_id,
        request_digest: authority.request_digest,
        snapshot_digest: authority.snapshot_digest,
        workspace_id: authority.workspace_id,
        generation: "gen-dominance",
        source_authority_digests: [authority.authority_digest],
        candidates: [
          sourceCandidate("a", authority, source),
          sourceCandidate("b", authority, source),
          sourceCandidate("c", authority, source)
        ],
        current_authorities: [authority]
      });
      const outcome = (left: string, right: string) => artifact.pair_outcomes.find((row) =>
        row.left_candidate_key === fieldKey(left) &&
        row.right_candidate_key === fieldKey(right))?.outcome;
      expect(outcome("a", "b")).toBe("strict_edge");
      expect(outcome("b", "a")).toBe("reverse_edge");
      expect(outcome("b", "c")).toBe("equal");
      expect(artifact.psi_edges).toContainEqual([fieldKey("a"), fieldKey("b")]);
      expect(artifact.first_frontier_size).toBe(1);
      expect(artifact.frontier_depth).toBeGreaterThan(1);
      expect(artifact.observation_status).toBe("observed");
      expect(artifact.producer_outcomes).toHaveLength(2);
    });
  });

  it("maps unresolved collapse to uncertain and blocked collapse to unsupported", () => {
    const artifact = issuePsiV2AuthorityArtifact({
      query_digest: "sha256:query-blocked",
      snapshot_digest: "sha256:snap-blocked",
      candidates: [
        candidate("left", [coordinate("p-1", {
          status: "unresolved",
          reason: "unknown correlation blocks collapse",
          observations: []
        })]),
        candidate("right", [coordinate("p-1", {
          status: "blocked",
          reason: "verified support measurement authority is unavailable",
          observations: []
        })])
      ],
      current_authorities: []
    });
    const leftRight = artifact.pair_outcomes.find((row) =>
      row.left_candidate_key === "left" && row.right_candidate_key === "right");
    expect(leftRight?.outcome).toBe("uncertain");
    const blockedOnly = issuePsiV2AuthorityArtifact({
      query_digest: "sha256:query-unsupported",
      snapshot_digest: "sha256:snap-unsupported",
      candidates: [
        candidate("left", [coordinate("p-1", {
          status: "blocked",
          reason: "verified support measurement authority is unavailable",
          observations: []
        })]),
        candidate("right", [coordinate("p-1", {
          status: "blocked",
          reason: "verified support measurement authority is unavailable",
          observations: []
        })])
      ],
      current_authorities: []
    });
    expect(blockedOnly.pair_outcomes.every((row) => row.outcome === "unsupported")).toBe(true);
  });

  it("fail-closes a peel cycle as explicit cycle status, not numeric-zero success", () => {
    const spy = vi.spyOn(compare, "comparePsiV2").mockReturnValue({
      kind: "dominates",
      reasons: Object.freeze(["forced cycle"])
    });
    try {
      const artifact = issuePsiV2AuthorityArtifact({
        query_digest: "sha256:query-cycle",
        snapshot_digest: "sha256:snap-cycle",
        candidates: [candidate("a"), candidate("b")],
        current_authorities: []
      });
      expect(artifact.cycle_status).toBe("cycle");
      expect(artifact.first_frontier_size).toBeNull();
      expect(artifact.frontier_depth).toBeNull();
      expect(artifact.peeled_layers).toEqual([]);
      expect(artifact.pair_outcomes).toHaveLength(2);
    } finally {
      spy.mockRestore();
    }
  });

  it("changes structural digest on query, snapshot, generation, and source drift", () => {
    const base = {
      candidates: [candidate("c-1"), candidate("c-2")],
      current_authorities: [] as CurrentMeasurementAuthoritiesV1
    };
    const original = issuePsiV2AuthorityArtifact({
      query_digest: "sha256:query-a",
      snapshot_digest: "sha256:snap-a",
      generation: "gen-a",
      source_authority_digests: ["sha256:src-a"],
      ...base
    });
    const queryDrift = issuePsiV2AuthorityArtifact({
      query_digest: "sha256:query-b",
      snapshot_digest: "sha256:snap-a",
      generation: "gen-a",
      source_authority_digests: ["sha256:src-a"],
      ...base
    });
    const snapshotDrift = issuePsiV2AuthorityArtifact({
      query_digest: "sha256:query-a",
      snapshot_digest: "sha256:snap-b",
      generation: "gen-a",
      source_authority_digests: ["sha256:src-a"],
      ...base
    });
    const generationDrift = issuePsiV2AuthorityArtifact({
      query_digest: "sha256:query-a",
      snapshot_digest: "sha256:snap-a",
      generation: "gen-b",
      source_authority_digests: ["sha256:src-a"],
      ...base
    });
    const sourceDrift = issuePsiV2AuthorityArtifact({
      query_digest: "sha256:query-a",
      snapshot_digest: "sha256:snap-a",
      generation: "gen-a",
      source_authority_digests: ["sha256:src-b"],
      ...base
    });
    const digests = [
      original.structural_digest,
      queryDrift.structural_digest,
      snapshotDrift.structural_digest,
      generationDrift.structural_digest,
      sourceDrift.structural_digest
    ];
    expect(new Set(digests).size).toBe(5);
  });

  it("captures input once so later mutation does not change the issued artifact", () => {
    const candidates: PsiV2CandidateV1[] = [candidate("c-1"), candidate("c-2")];
    const artifact = issuePsiV2AuthorityArtifact({
      query_digest: "sha256:query-mut",
      snapshot_digest: "sha256:snap-mut",
      candidates,
      current_authorities: []
    });
    candidates.push(candidate("c-3"));
    expect(artifact.candidate_universe).toEqual(["c-1", "c-2"]);
    expect(artifact.pair_outcomes).toHaveLength(2);
  });

  it("fails closed on getter and Proxy inputs", () => {
    const plain = {
      query_digest: "sha256:query-proxy",
      snapshot_digest: "sha256:snap-proxy",
      candidates: [candidate("c-1")],
      current_authorities: [] as CurrentMeasurementAuthoritiesV1
    };
    const withGetter = { ...plain };
    Object.defineProperty(withGetter, "candidates", {
      get: () => [candidate("c-1"), candidate("c-2")]
    });
    expect(() => issuePsiV2AuthorityArtifact(withGetter)).toThrow(ShadowContractError);
    expect(() => issuePsiV2AuthorityArtifact(new Proxy(plain, {}))).toThrow(ShadowContractError);
  });
});

function candidate(
  candidateId: string,
  coordinates: PsiV2CandidateV1["coordinates"] = []
): PsiV2CandidateV1 {
  return Object.freeze({
    candidate_id: candidateId,
    coordinates: Object.freeze([...coordinates])
  });
}

function coordinate(
  propositionId: string,
  collapse: PsiV2CandidateV1["coordinates"][number]["collapse"]
): PsiV2CandidateV1["coordinates"][number] {
  return Object.freeze({
    proposition_id: propositionId,
    proposition_schema: "ps",
    identity: null,
    collapse,
    admission: null,
    applicable: true,
    lex_domain: null,
    envelope_identity: null
  });
}

async function withField(
  rows: readonly (readonly [string, number])[],
  work: (
    authority: Parameters<Parameters<
      typeof withCapturedLexicalMeasurementAuthorityFixture
    >[2]>[0],
    source: LexicalIntervalSourceReceiptCapturedV1
  ) => void
): Promise<void> {
  await withCapturedLexicalMeasurementAuthorityFixture(
    prepared,
    rows.map(([candidate_key, normalized_rank]) => ({ candidate_key, normalized_rank })),
    (authority, source) => {
      if (source.status !== "captured") throw new Error("captured source expected");
      work(authority, source);
    }
  );
}

function sourceCandidate(
  key: string,
  authority: Parameters<Parameters<
    typeof withCapturedLexicalMeasurementAuthorityFixture
  >[2]>[0],
  source: LexicalIntervalSourceReceiptCapturedV1
): PsiV2CandidateV1 {
  const candidateKey = fieldKey(key);
  return psiV2CandidateFromLexicalEnvelope(
    candidateKey,
    lexicalIntervalSourceEnvelopes(source, candidateKey),
    authority
  );
}

function fieldKey(objectId: string): string {
  return `workspace_local:memory_entry:${objectId}`;
}
