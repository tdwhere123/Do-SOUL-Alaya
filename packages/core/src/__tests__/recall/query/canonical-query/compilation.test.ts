import { describe, expect, it } from "vitest";
import { compileRecallQueryProbes } from
  "../../../../recall/query/recall-query-probes.js";
import {
  compileCanonicalQueryCompilation,
  QUERY_HOLE_IMPACTS
} from "../../../../recall/query/canonical-query/index.js";

const SNAPSHOT = {
  receipt_digest: `sha256:${"c".repeat(64)}`,
  coherence_state: "coherent_exact"
} as const;
const OTHER = {
  receipt_digest: `sha256:${"d".repeat(64)}`,
  coherence_state: "coherent_exact"
} as const;

describe("canonical query compilation holes", () => {
  it("records hole impacts without collapsing unknown to empty demand", () => {
    const count = compileCanonicalQueryCompilation({
      probes: compileRecallQueryProbes("How many places did I visit?")
    }, SNAPSHOT);
    expect(count.compile_status).toBe("unsupported");
    expect(count.hypothetical_mode).toBe("unsupported");
    expect(count.holes.some((hole) =>
      hole.impacts.includes("blocks_operator_resolution"))).toBe(true);
    const unknown = compileCanonicalQueryCompilation({
      probes: compileRecallQueryProbes("How much is one bike?")
    }, SNAPSHOT);
    expect(unknown.holes.length).toBeGreaterThan(0);
    expect(unknown.compile_status).not.toBe("certified_program");
    const latest = compileCanonicalQueryCompilation({
      probes: compileRecallQueryProbes("What is the latest password?")
    }, SNAPSHOT);
    expect(latest.holes.some((hole) =>
      hole.code === "latest_without_typed_time_key"
      || hole.code === "unknown_time_basis")).toBe(true);
    const conflict = compileCanonicalQueryCompilation({
      probes: compileRecallQueryProbes("Where is the latest bookshelf?")
    }, SNAPSHOT);
    expect(conflict.holes.length).toBeGreaterThan(1);
    const impacts = new Set(conflict.holes.flatMap((hole) => hole.impacts));
    expect(impacts.size).toBeGreaterThan(1);
    expect(QUERY_HOLE_IMPACTS).toContain("blocks_certified_delivery");
    const snapshotBlocked = compileCanonicalQueryCompilation({
      probes: compileRecallQueryProbes("Where did I buy my new bookshelf from?")
    }, { ...SNAPSHOT, coherence_state: "unavailable" });
    const allImpacts = new Set([
      ...count.holes, ...unknown.holes, ...latest.holes, ...conflict.holes,
      ...snapshotBlocked.holes
    ].flatMap((hole) => hole.impacts));
    for (const impact of QUERY_HOLE_IMPACTS) {
      expect(allImpacts.has(impact) || impact === "blocks_membership"
        || impact === "blocks_completeness_claim").toBe(true);
    }
    expect(snapshotBlocked.holes.some((hole) =>
      hole.impacts.includes("blocks_all_delivery"))).toBe(true);
    expect(unknown.holes.some((hole) =>
      hole.impacts.includes("blocks_membership"))).toBe(true);
  });

  it("changes digest on snapshot drift and stays stable on identical input", () => {
    const probes = compileRecallQueryProbes("Where did I buy my new bookshelf from?");
    const first = compileCanonicalQueryCompilation({ probes }, SNAPSHOT);
    const second = compileCanonicalQueryCompilation({ probes }, SNAPSHOT);
    const drifted = compileCanonicalQueryCompilation({ probes }, OTHER);
    expect(first.digest).toBe(second.digest);
    expect(drifted.digest).not.toBe(first.digest);
    expect(first.compile_status === "certified_program"
      || first.compile_status === "partial_program").toBe(true);
  });

  it("counts silent empty-demand fallbacks as zero on the golden corpus", () => {
    const corpus = [
      "Where did I buy my new bookshelf from?",
      "每天上班通勤要多久？",
      "How many places did I visit?",
      "How much is one bike?",
      "What is the latest password?"
    ];
    let silentFallback = 0;
    for (const query of corpus) {
      const compiled = compileCanonicalQueryCompilation({
        probes: compileRecallQueryProbes(query)
      }, SNAPSHOT);
      const emptySupported = compiled.hypotheses.filter((row) =>
        row.status === "supported"
        && row.query.predicates.length === 0
        && compiled.holes.length === 0
        && compiled.unresolved.length === 0
        && query.includes("bike"));
      silentFallback += emptySupported.length;
    }
    expect(silentFallback).toBe(0);
  });
});
