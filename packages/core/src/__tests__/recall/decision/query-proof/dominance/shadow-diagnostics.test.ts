import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { D1CandidateEnvelopeMap, D1EnvelopeIdentity } from
  "../../../../../recall/decision/query-proof/adapters/lexical-bound/legal-envelope.js";
import * as frontierPeel from "../../../../../recall/decision/query-proof/frontier-peel.js";
import * as authority from "../../../../../recall/decision/query-proof/dominance/authority.js";
import type { LexDomain } from "../../../../../recall/decision/query-proof/observations.js";
import {
  adaptLexicalIntervalEnvelopeToCollapse,
  buildPsiV2ShadowDiagnostics,
  malformedPsiV2ShadowDiagnostics,
  LEXICAL_INTERVAL_MEASUREMENT_CONTRACT,
  psiV2CandidateFromLexicalEnvelope,
  comparePsiV2
} from "../../../../../recall/decision/query-proof/dominance/index.js";
import { issuePsiV2AuthorityArtifact } from
  "../../../../../recall/decision/query-proof/dominance/authority.js";
import type { VerifiedMeasurementAuthorityV1 } from
  "../../../../../recall/decision/query-proof/measurement/index.js";
import { PINS, PROV } from "../witness/fixtures.js";

const SNAPSHOT = PINS.snapshot_digest;
const CANONICAL_SRC = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../../../recall/delivery/canonical-delivery.ts"
  ),
  "utf8"
);

const EXACT_DOMAIN: LexDomain = {
  lane_id: "exact",
  list_n: 8,
  status: "complete",
  raw_key_kind: "matched_token_count"
};

const PORTER_DOMAIN: LexDomain = {
  lane_id: "porter",
  list_n: 8,
  status: "complete",
  raw_key_kind: "bm25_raw_rank"
};

const ENVELOPE_IDENTITY: D1EnvelopeIdentity = {
  field_prefix: "lexical_relaxed",
  query_run_id: "q",
  snapshot_digest: SNAPSHOT,
  request_digest: `sha256:${"c".repeat(64)}`,
  workspace_id: "workspace-1"
};

const PREPARED_IDENTITY = {
  query_id: "q",
  snapshot_digest: SNAPSHOT,
  request_digest: ENVELOPE_IDENTITY.request_digest,
  workspace_id: ENVELOPE_IDENTITY.workspace_id,
  field_prefix: null,
  candidate_key_domain: null,
  contract_digest: `sha256:${"4".repeat(64)}` as `sha256:${string}`,
  authority_digest: `sha256:${"5".repeat(64)}` as `sha256:${string}`
} as unknown as VerifiedMeasurementAuthorityV1;

describe("psi v2 shadow diagnostics", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("leaves unbounded or inverted lexical interval unresolved", () => {
    const unbounded = adaptLexicalIntervalEnvelopeToCollapse(
      { kind: "unbounded" },
      PINS,
      PROV,
      ENVELOPE_IDENTITY,
      PREPARED_IDENTITY
    );
    const inverted = adaptLexicalIntervalEnvelopeToCollapse(
      { kind: "interval", lower: 4, upper: 1 },
      PINS,
      PROV,
      ENVELOPE_IDENTITY,
      PREPARED_IDENTITY
    );
    expect(unbounded).toMatchObject({
      status: "unresolved",
      reason: "unbounded lexical-bound proof remains unresolved"
    });
    expect(inverted).toMatchObject({
      status: "unresolved",
      reason: "inverted lexical interval remains unresolved"
    });
    const exact = adaptLexicalIntervalEnvelopeToCollapse(
      { kind: "interval", lower: 2, upper: 2 },
      {
        ...PINS,
        query_id: "q",
        candidate_id: "cand-1",
        proposition_id: "lex.interval"
      },
      PROV,
      ENVELOPE_IDENTITY,
      PREPARED_IDENTITY
    );
    expect(exact).toMatchObject({
      status: "unresolved",
      reason: "lexical envelope does not match the prepared request identity"
    });
  });

  it("does not collapse a non-null envelope identity forged for another query or snapshot", () => {
    const queryMismatch = adaptLexicalIntervalEnvelopeToCollapse(
      { kind: "interval", lower: 4, upper: 4 },
      { ...PINS, query_id: "other-query" },
      PROV,
      ENVELOPE_IDENTITY,
      PREPARED_IDENTITY
    );
    const snapshotMismatch = adaptLexicalIntervalEnvelopeToCollapse(
      { kind: "interval", lower: 4, upper: 4 },
      { ...PINS, query_id: "q", snapshot_digest: `sha256:${"d".repeat(64)}` },
      PROV,
      ENVELOPE_IDENTITY,
      PREPARED_IDENTITY
    );
    expect(queryMismatch).toMatchObject({
      status: "unresolved",
      reason: "prepared query identity does not match the observation pin"
    });
    expect(snapshotMismatch).toMatchObject({
      status: "unresolved",
      reason: "prepared query identity does not match the observation pin"
    });
  });

  it("does not collapse a well-ordered interval without a legal envelope identity", () => {
    const tampered = adaptLexicalIntervalEnvelopeToCollapse(
      { kind: "interval", lower: 4, upper: 4 },
      PINS,
      PROV,
      null,
      PREPARED_IDENTITY
    );
    expect(tampered).toMatchObject({
      status: "unresolved",
      reason: "forged lexical interval without legal envelope identity remains unresolved"
    });
  });

  it("binds the lexical-interval contract without plan-card labels", () => {
    expect(LEXICAL_INTERVAL_MEASUREMENT_CONTRACT.contract_id)
      .toBe("measure.lexical.interval.v1");
    expect(LEXICAL_INTERVAL_MEASUREMENT_CONTRACT.proposition_schema)
      .toBe("lex.interval");
  });

  it("emits deterministic producer diagnostics without inventing Psi summaries", () => {
    const issue = vi.spyOn(authority, "issuePsiV2AuthorityArtifact");
    const first = buildPsiV2ShadowDiagnostics({
      query_id: "q",
      snapshot_digest: SNAPSHOT,
      candidate_keys: ["workspace_local:memory_entry:a", "workspace_local:memory_entry:b"],
      lexical_interval_by_key: {
        "workspace_local:memory_entry:a": lexicalIntervalMap(9, 9),
        "workspace_local:memory_entry:b": lexicalIntervalMap(1, 1)
      }
    });
    const second = buildPsiV2ShadowDiagnostics({
      query_id: "q",
      snapshot_digest: SNAPSHOT,
      candidate_keys: ["workspace_local:memory_entry:a", "workspace_local:memory_entry:b"],
      lexical_interval_by_key: {
        "workspace_local:memory_entry:a": lexicalIntervalMap(9, 9),
        "workspace_local:memory_entry:b": lexicalIntervalMap(1, 1)
      }
    });
    expect(first.digest).toBe(second.digest);
    expect(first.raw_fragment_veto).toBe(false);
    expect(first.observation_status).toBe("observed");
    expect(first.cycle_count).toBeNull();
    expect(first.first_frontier_size).toBeNull();
    expect(first.frontier_depth).toBeNull();
    expect(first.pair_state_counts).toBeNull();
    expect(first.frontier_width).toBeNull();
    expect(issue).not.toHaveBeenCalled();
  });

  it("projects pair counts, cycle, and frontiers only from the issued artifact", () => {
    const issue = vi.spyOn(authority, "issuePsiV2AuthorityArtifact");
    const candidates = [
      psiV2CandidateFromLexicalEnvelope(
        "workspace_local:memory_entry:a",
        lexicalIntervalMap(9, 9),
        "q",
        SNAPSHOT
      ),
      psiV2CandidateFromLexicalEnvelope(
        "workspace_local:memory_entry:b",
        lexicalIntervalMap(1, 1),
        "q",
        SNAPSHOT
      )
    ];
    const artifact = issuePsiV2AuthorityArtifact({
      query_digest: "q",
      snapshot_digest: SNAPSHOT,
      candidates,
      current_authorities: []
    });
    issue.mockClear();
    const diagnostics = buildPsiV2ShadowDiagnostics({
      query_id: "q",
      snapshot_digest: SNAPSHOT,
      candidate_keys: ["workspace_local:memory_entry:a", "workspace_local:memory_entry:b"],
      lexical_interval_by_key: {
        "workspace_local:memory_entry:a": lexicalIntervalMap(9, 9),
        "workspace_local:memory_entry:b": lexicalIntervalMap(1, 1)
      },
      issued_artifact: artifact
    });
    expect(issue).not.toHaveBeenCalled();
    expect(diagnostics.first_frontier_size).toBe(artifact.first_frontier_size);
    expect(diagnostics.frontier_depth).toBe(artifact.frontier_depth);
    expect(diagnostics.frontier_width).toBe(artifact.frontier_depth);
    expect(diagnostics.cycle_count).toBe(artifact.cycle_status === "cycle" ? 1 : 0);
    expect(diagnostics.pair_state_counts).toEqual({
      strict_edge: artifact.pair_outcomes.filter((row) => row.outcome === "strict_edge").length,
      reverse_edge: artifact.pair_outcomes.filter((row) => row.outcome === "reverse_edge").length,
      equal: artifact.pair_outcomes.filter((row) => row.outcome === "equal").length,
      incomparable: artifact.pair_outcomes.filter((row) => row.outcome === "incomparable").length,
      tradeoff: artifact.pair_outcomes.filter((row) => row.outcome === "tradeoff").length,
      uncertain: artifact.pair_outcomes.filter((row) => row.outcome === "uncertain").length,
      unsupported: artifact.pair_outcomes.filter((row) => row.outcome === "unsupported").length
    });
    expect(diagnostics.first_frontier_size).not.toBe(diagnostics.frontier_depth);
  });

  it("records a raw-fragment veto when prepared measurement identity is absent", () => {
    const diagnostics = buildPsiV2ShadowDiagnostics({
      query_id: "q",
      snapshot_digest: SNAPSHOT,
      candidate_keys: ["workspace_local:memory_entry:a", "workspace_local:memory_entry:b"],
      lexical_interval_by_key: {
        "workspace_local:memory_entry:a": lexicalIntervalMap(9, 9, { porter: [4, 4] }),
        "workspace_local:memory_entry:b": lexicalIntervalMap(1, 1)
      }
    });
    expect(diagnostics.raw_fragment_veto).toBe(true);
    expect(diagnostics.observation_status).toBe("observed");
  });

  it("does not collapse a stale proof map whose duplicated identity pins disagree", () => {
    const stale = {
      ...lexicalIntervalMap(9, 9),
      snapshot_digest: `sha256:${"e".repeat(64)}`
    };
    const candidate = psiV2CandidateFromLexicalEnvelope(
      "workspace_local:memory_entry:a",
      stale,
      "q",
      SNAPSHOT
    );
    expect(candidate.coordinates[0]?.collapse).toMatchObject({
      status: "unresolved",
      reason: "lexical envelope proof map identity is inconsistent"
    });
  });

  it("keeps an unresolved proposition blocking and records a raw-fragment veto", () => {
    const diagnostics = buildPsiV2ShadowDiagnostics({
      query_id: "q",
      snapshot_digest: SNAPSHOT,
      candidate_keys: ["workspace_local:memory_entry:a", "workspace_local:memory_entry:b"],
      lexical_interval_by_key: {
        "workspace_local:memory_entry:a": lexicalIntervalMap(9, 9, { porter: [4, 4] }),
        "workspace_local:memory_entry:b": missingPrimaryMap()
      }
    });
    const left = psiV2CandidateFromLexicalEnvelope(
      "workspace_local:memory_entry:a",
      lexicalIntervalMap(9, 9, { porter: [4, 4] }),
      "q",
      SNAPSHOT
    );
    const right = psiV2CandidateFromLexicalEnvelope(
      "workspace_local:memory_entry:b",
      missingPrimaryMap(),
      "q",
      SNAPSHOT
    );
    expect(comparePsiV2(left, right, []).kind).toBe("blocked");
    expect(diagnostics.raw_fragment_veto).toBe(true);
    expect(diagnostics.blocked_share).toBeNull();
    expect(diagnostics.pair_state_counts).toBeNull();
  });

  it("does not treat malformed diagnostics as numeric-zero success", () => {
    const diagnostics = malformedPsiV2ShadowDiagnostics();
    expect(diagnostics.observation_status).toBe("malformed");
    expect(diagnostics.frontier_width).toBeNull();
    expect(diagnostics.first_frontier_size).toBeNull();
    expect(diagnostics.frontier_depth).toBeNull();
    expect(diagnostics.cycle_count).toBeNull();
    expect(diagnostics.pair_state_counts).toBeNull();
    expect(diagnostics.undominated_share).toBeNull();
  });

  it("marks empty input not_observed instead of a finished frontier", () => {
    const empty = buildPsiV2ShadowDiagnostics({
      query_id: "q",
      snapshot_digest: SNAPSHOT,
      candidate_keys: ["workspace_local:memory_entry:a", "workspace_local:memory_entry:b"]
    });
    expect(empty.observation_status).toBe("not_observed");
    expect(empty.undominated_share).toBeNull();
    expect(empty.frontier_width).toBeNull();
    expect(empty.blocked_share).toBeNull();
    expect(empty.first_frontier_size).toBeNull();
    expect(empty.frontier_depth).toBeNull();
    expect(empty.cycle_count).toBeNull();
    expect(empty.pair_state_counts).toBeNull();
    expect(empty.visibility).toBeNull();
  });

  it("keeps support absence, unavailability, and malformation visible beside lexical observations", () => {
    const supportOutcomes = [
      { producer_id: "support", status: "not_observed", reason: "applicable_receipt_absent" },
      { producer_id: "support", status: "producer_unavailable", reason: "source_unavailable" },
      { producer_id: "support", status: "malformed", contract_code: "duplicate_receipt" }
    ] as const;
    const diagnostics = supportOutcomes.map((supportOutcome) =>
      buildPsiV2ShadowDiagnostics({
        query_id: "q",
        snapshot_digest: SNAPSHOT,
        candidate_keys: ["workspace_local:memory_entry:a"],
        lexical_interval_by_key: {
          "workspace_local:memory_entry:a": lexicalIntervalMap(2, 2)
        },
        producer_outcomes: [
          { producer_id: "lex.interval", status: "observed" },
          supportOutcome
        ]
      }));
    expect(diagnostics.map((row) => row.observation_status))
      .toEqual(["observed", "producer_unavailable", "malformed"]);
    expect(diagnostics.map((row) => row.producer_outcomes[1])).toEqual(supportOutcomes);
    expect(new Set(diagnostics.map((row) => JSON.stringify(row.producer_outcomes))).size).toBe(3);
    expect(new Set(diagnostics.map((row) => row.digest)).size).toBe(3);
    expect(diagnostics[0]?.reasons).toContain(
      "support producer not_observed: applicable_receipt_absent");
    expect(diagnostics[1]?.reasons).toContain(
      "support producer producer_unavailable: source_unavailable");
    expect(diagnostics[2]?.reasons).toContain(
      "support producer malformed: duplicate_receipt");
  });

  it("emits conflict, alias, unknown-correlation, and unsupported visibility when passed in", () => {
    const diagnostics = buildPsiV2ShadowDiagnostics({
      query_id: "q",
      snapshot_digest: SNAPSHOT,
      candidate_keys: ["workspace_local:memory_entry:a"],
      lexical_interval_by_key: {
        "workspace_local:memory_entry:a": lexicalIntervalMap(2, 2)
      },
      aliases: [{ left_id: "bind-a", right_id: "bind-b", state: "may_equal" }],
      correlations: [{
        left_id: "ev-a",
        right_id: "ev-b",
        state: "possibly_correlated"
      }],
      conflicts: [{ kind: "conflict" }],
      unsupported: [{
        kind: "osf_unavailable",
        owner: "osf",
        detail: "producer missing"
      }]
    });
    expect(diagnostics.observation_status).toBe("observed");
    expect(diagnostics.visibility).toEqual({
      conflict: true,
      alias: true,
      unknown_correlation: true,
      unsupported: true
    });
  });

  it("does not peel observation diagnostics through peelUndominated", () => {
    const peel = vi.spyOn(frontierPeel, "peelUndominated");
    buildPsiV2ShadowDiagnostics({
      query_id: "q",
      snapshot_digest: SNAPSHOT,
      candidate_keys: ["workspace_local:memory_entry:a", "workspace_local:memory_entry:b"],
      lexical_interval_by_key: {
        "workspace_local:memory_entry:a": lexicalIntervalMap(9, 9),
        "workspace_local:memory_entry:b": lexicalIntervalMap(1, 1)
      }
    });
    expect(peel).not.toHaveBeenCalled();
  });

  it("keeps psi_v2_shadow off the hashed canonical receipt body", () => {
    const start = CANONICAL_SRC.indexOf("function capturedReceiptBody");
    const end = CANONICAL_SRC.indexOf("function failClosedSelectionReceipt");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(CANONICAL_SRC.slice(start, end)).not.toContain("psi_v2_shadow");
    expect(CANONICAL_SRC).not.toContain("psi_v2_shadow");
  });
});

function lexicalIntervalMap(
  lower: number,
  upper: number,
  extra: { readonly porter?: readonly [number, number] } = {}
): D1CandidateEnvelopeMap {
  return envelopeMap({
    identity: ENVELOPE_IDENTITY,
    primary: {
      domain: EXACT_DOMAIN,
      envelope: { kind: "interval", lower, upper }
    },
    porter: extra.porter
  });
}

function missingPrimaryMap(): D1CandidateEnvelopeMap {
  return envelopeMap({
    identity: ENVELOPE_IDENTITY,
    primary: null,
    porter: [1, 1]
  });
}

function envelopeMap(input: {
  readonly identity: D1EnvelopeIdentity | null;
  readonly primary: D1CandidateEnvelopeMap["primary"];
  readonly porter?: readonly [number, number];
}): D1CandidateEnvelopeMap {
  return {
    identity: input.identity,
    field_prefix: input.identity?.field_prefix ?? null,
    query_run_id: input.identity?.query_run_id ?? null,
    snapshot_digest: input.identity?.snapshot_digest ?? null,
    request_digest: input.identity?.request_digest ?? null,
    primary: input.primary,
    lanes: input.porter === undefined ? {} : {
      porter: {
        domain: PORTER_DOMAIN,
        value: { kind: "interval", lower: input.porter[0], upper: input.porter[1] }
      }
    }
  };
}
