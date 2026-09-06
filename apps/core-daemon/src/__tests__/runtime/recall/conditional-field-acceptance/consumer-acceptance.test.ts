import { describe, expect, it } from "vitest";
import {
  assertNoReselection,
  assertPageContinuity,
  assertPartialTransport,
  assertTargetConsumer,
  assertUnknownCauseAllowed,
  completenessDimensions,
  CONTRACT_ONLY_UNTIL_C07,
  entryIdentity
} from "./consumer-contract.js";
import {
  DEPLOYMENT_MILLIGRADES,
  coverageIndex,
  deploymentEntries,
  pagedIndex,
  stubCliRecall,
  stubMcpRecall
} from "./frozen-entry.js";

describe("conditional-field MCP/CLI acceptance (contract-only)", () => {
  it("A01/A02 expose last-week config and unknown-cause history through the consumer payload", () => {
    const index = pagedIndex(800);
    const mcp = stubMcpRecall(index);
    const cli = stubCliRecall(index);
    expect(assertTargetConsumer(mcp)).toEqual([]);
    expect(assertTargetConsumer(cli)).toEqual([]);
    expect(mcp.index.entries.find((entry) => entry.object_id === "c")?.association_milligrades)
      .toBe(DEPLOYMENT_MILLIGRADES.c);
    expect(mcp.index.entries.find((entry) => entry.object_id === "h")?.association_milligrades)
      .toBe(DEPLOYMENT_MILLIGRADES.h);
    expect(assertUnknownCauseAllowed(mcp.index)).toEqual([]);
    expect(mcp.note).toBe(CONTRACT_ONLY_UNTIL_C07);
    expect(cli.surface).toBe("cli");
  });

  it("A13 allows a complete logical index that still contains unknown cause", () => {
    const index = pagedIndex(800);
    expect(index.completeness.logical_index).toBe("complete");
    expect(assertUnknownCauseAllowed(index)).toEqual([]);
    expect(index.entries.some((entry) => entry.claim === "unknown")).toBe(true);
  });

  it("A14 keeps page identity and concatenates without a second selector", () => {
    const first = pagedIndex(2, 0);
    const second = pagedIndex(2, 2);
    const full = pagedIndex(800);
    expect(assertPageContinuity([first, second], full)).toEqual([]);
    const mcp = stubMcpRecall(full);
    expect(assertNoReselection(mcp, full.entries.map(entryIdentity))).toEqual([]);
    const reselected = stubMcpRecall({
      ...full,
      entries: [...full.entries].reverse()
    });
    expect(assertNoReselection(reselected, full.entries.map(entryIdentity)).length).toBeGreaterThan(0);
  });

  it("A15 distinguishes logical completeness from partial transport and payload", () => {
    const first = pagedIndex(1, 0);
    expect(assertPartialTransport(first)).toEqual([]);
    expect(completenessDimensions(first.completeness)).toEqual([
      "complete",
      "complete",
      "partial",
      "partial",
      "complete"
    ]);
    expect(first.continuation).not.toBeNull();
    const compact = stubMcpRecall(first);
    expect(compact.index.entries).toHaveLength(1);
    expect(compact.index.completeness.transport).not.toBe("complete");
  });

  it("A12 reports empty exhausted versus unavailable versus cancelled", () => {
    const empty = coverageIndex("exhausted_empty", "complete");
    expect(empty.completeness.logical_index).toBe("complete");
    expect(empty.completeness.observed_coverage).toBe("exhausted_empty");
    const unavailable = coverageIndex("unavailable", "unavailable");
    expect(unavailable.completeness.logical_index).not.toBe("complete");
    const cancelled = coverageIndex("cancelled", "open");
    expect(cancelled.completeness.logical_index).not.toBe("complete");
    expect(cancelled.completeness.observed_coverage).toBe("cancelled");
  });

  it("rejects a consumer payload that reintroduces ranking_authority or delivery_path", () => {
    const mcp = stubMcpRecall(pagedIndex(800));
    const smuggled = {
      ...mcp,
      ranking_authority: "select_gamma",
      delivery_path: "canonical"
    };
    expect(assertTargetConsumer(smuggled as typeof mcp).join(" ")).toMatch(/ranking_authority|delivery_path/);
    expect("results" in mcp).toBe(false);
    expect(mcp.index.entries.map((entry) => entry.object_id).sort()).toEqual(
      deploymentEntries().map((entry) => entry.object_id).sort()
    );
  });
});
