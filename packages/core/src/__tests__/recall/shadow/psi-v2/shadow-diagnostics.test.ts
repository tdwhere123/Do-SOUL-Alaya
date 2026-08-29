import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { D1CandidateEnvelopeMap } from
  "../../../../recall/shadow/d1/legal-envelope.js";
import * as frontierPeel from "../../../../recall/shadow/frontier-peel.js";
import {
  adaptLexicalIntervalEnvelopeToCollapse,
  buildPsiV2ShadowDiagnostics,
  LEXICAL_INTERVAL_MEASUREMENT_CONTRACT
} from "../../../../recall/shadow/psi-v2/index.js";
import { PINS, PROV } from "../witness/fixtures.js";

const SNAPSHOT = PINS.snapshot_digest;
const CANONICAL_SRC = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../../recall/shadow/canonical-delivery.ts"
  ),
  "utf8"
);

describe("psi v2 shadow diagnostics", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("leaves unbounded or inverted lexical interval unresolved", () => {
    const unbounded = adaptLexicalIntervalEnvelopeToCollapse(
      { kind: "unbounded" },
      PINS,
      PROV
    );
    const inverted = adaptLexicalIntervalEnvelopeToCollapse(
      { kind: "interval", lower: 4, upper: 1 },
      PINS,
      PROV
    );
    expect(unbounded.status).toBe("unresolved");
    expect(unbounded.reason).toBe("unbounded lexical-bound proof remains unresolved");
    expect(inverted.status).toBe("unresolved");
    expect(inverted.reason).toBe("inverted lexical interval remains unresolved");
    const exact = adaptLexicalIntervalEnvelopeToCollapse(
      { kind: "interval", lower: 2, upper: 2 },
      { ...PINS, candidate_id: "cand-1", proposition_id: "lex.interval" },
      PROV
    );
    expect(exact.status).toBe("collapsed");
  });

  it("binds the lexical-interval contract without plan-card labels", () => {
    expect(LEXICAL_INTERVAL_MEASUREMENT_CONTRACT.contract_id)
      .toBe("measure.lexical.interval.v1");
    expect(LEXICAL_INTERVAL_MEASUREMENT_CONTRACT.proposition_schema)
      .toBe("lex.interval");
  });

  it("emits deterministic mechanism metrics without a raw-fragment veto after collapse", () => {
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
    expect(first.cycle_count).toBe(0);
    expect(first.raw_fragment_veto).toBe(false);
    expect(first.frontier_width).toBeGreaterThan(0);
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

function lexicalIntervalMap(lower: number, upper: number): D1CandidateEnvelopeMap {
  return {
    identity: null,
    field_prefix: null,
    query_run_id: null,
    snapshot_digest: null,
    request_digest: null,
    primary: {
      domain: {
        lane_id: "exact",
        list_n: 8,
        status: "complete",
        raw_key_kind: "matched_token_count"
      },
      envelope: { kind: "interval", lower, upper }
    },
    lanes: {}
  };
}
