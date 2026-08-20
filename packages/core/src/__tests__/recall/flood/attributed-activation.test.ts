import { describe, expect, it, vi } from "vitest";
import type {
  AttributedActivationPort,
  AttributedActivationReceipt
} from "@do-soul/alaya-protocol";
import {
  createAttributedActivationPort,
  runAttributedActivation
} from "../../../recall/flood/activation/attributed-activation.js";
import { captureQueryCondition } from
  "../../../recall/query/condition/query-condition-capture.js";
import {
  CLOCK_AS_OF,
  conditionDraft,
  edge,
  frozenClock,
  GENERATION_ID,
  graph,
  node,
  OTHER_GENERATION_ID,
  testPin,
  testSha256
} from "../query/query-condition-test-fixtures.js";

function capture(overrides: Parameters<typeof conditionDraft>[0] = {}) {
  return captureQueryCondition(conditionDraft(overrides), {
    sha256: testSha256(),
    now: frozenClock(),
    pin: testPin()
  });
}

describe("attributed activation", () => {
  it("implements AttributedActivationPort and does not return a stop certificate", () => {
    const condition = capture();
    const port: AttributedActivationPort = createAttributedActivationPort({
      sha256: testSha256(),
      graph: graph(
        [node("seed", { authorized_anchor: true })],
        []
      )
    });
    const receipt: AttributedActivationReceipt = port.attribute(condition);

    expect(receipt.workspace_id).toBe("workspace-1");
    expect(receipt.generation_id).toBe(GENERATION_ID);
    expect(receipt.condition_digest).toBe(condition.identity);
    expect(receipt.seed_ids).toEqual(["seed"]);
    expect(receipt.opened_candidate_keys).toEqual(["seed"]);
    expect(receipt.stop_disposition).toBe("certified");
    expect(receipt.frontier).toBe("closed");
    expect(receipt).not.toHaveProperty("operator_id");
    expect(receipt).not.toHaveProperty("reason");
    expect(receipt).not.toHaveProperty("exchange_bounds");
  });

  it("opens adopted projections and denies cross-scope neighbors", () => {
    const trace = runAttributedActivation(capture(), {
      sha256: testSha256(),
      graph: graph([
        node("seed", { authorized_anchor: true, task_factor_id: "task:ada" }),
        node("adopted", {
          scope: "foreign-scope",
          adopted_bridge: "bridge-adopt"
        }),
        node("denied", { scope: "secret-scope" })
      ], [
        edge("seed", "adopted"),
        edge("seed", "denied")
      ])
    });

    expect(trace.receipt.opened_candidate_keys).toEqual(["adopted", "seed"]);
    expect(trace.receipt.opened_candidate_keys).not.toContain("denied");
    expect(trace.effective_as_of).toBe(CLOCK_AS_OF);
  });

  it("keeps membership monotone and freezes seeds at start", () => {
    const lateSeeds: string[] = [];
    const write = { persist: vi.fn((record: { readonly candidate_key: string }) => {
      lateSeeds.push(record.candidate_key);
    }) };
    const seed = node("seed", { authorized_anchor: true });
    const neighbor = node("neighbor");
    const late = node("late-seed", { authorized_anchor: true });
    const trace = runAttributedActivation(capture(), {
      sha256: testSha256(),
      write,
      graph: graph([seed, neighbor], [edge("seed", "neighbor")])
    });

    expect(write.persist).not.toHaveBeenCalled();
    expect(lateSeeds).toEqual([]);
    expect(trace.write_back_count).toBe(0);
    expect(trace.receipt.seed_ids).toEqual(["seed"]);
    expect(trace.receipt.opened_candidate_keys).toEqual(["neighbor", "seed"]);
    expect(trace.receipt.opened_candidate_keys).not.toContain(late.candidate_key);
    const before = trace.receipt.opened_candidate_keys;
    expect(before).toEqual([...before].sort((left, right) =>
      left === right ? 0 : left < right ? -1 : 1
    ));
  });

  it("records channel, source, edge, and hop attribution", () => {
    const trace = runAttributedActivation(capture(), {
      sha256: testSha256(),
      graph: graph([
        node("seed", { authorized_anchor: true }),
        node("mid"),
        node("leaf")
      ], [
        edge("seed", "mid", { channel: "path", source: "src-a" }),
        edge("mid", "leaf", { channel: "path", source: "src-b" })
      ])
    });

    expect(trace.paths).toEqual(expect.arrayContaining([
      expect.objectContaining({
        channel: "path",
        source: "src-a",
        from: "seed",
        to: "mid",
        hop: 1
      }),
      expect.objectContaining({
        channel: "path",
        source: "src-b",
        from: "mid",
        to: "leaf",
        hop: 2
      })
    ]));
    expect(trace.paths.every((path) => path.energy > 0)).toBe(true);
  });

  it("marks budget exhaustion uncertified/incomplete, never full-field exhaustion", () => {
    const exhausted = runAttributedActivation(capture({ activation_budget: 1 }), {
      sha256: testSha256(),
      graph: graph([
        node("seed", { authorized_anchor: true }),
        node("mid"),
        node("leaf")
      ], [
        edge("seed", "mid"),
        edge("mid", "leaf")
      ])
    });
    const dissipated = runAttributedActivation(capture({ activation_budget: 16 }), {
      sha256: testSha256(),
      graph: graph([
        node("seed", { authorized_anchor: true }),
        node("mid"),
        node("leaf")
      ], [
        edge("seed", "mid", { lambda: 0.4, hop_cost: 0.1 }),
        edge("mid", "leaf", { lambda: 0.4, hop_cost: 0.1 })
      ])
    });

    expect(exhausted.receipt.stop_disposition).toBe("uncertified");
    expect(exhausted.receipt.frontier).toBe("incomplete");
    expect(exhausted.budget.remaining).toBe(0);
    expect(exhausted.receipt.opened_candidate_keys).toContain("seed");
    expect(dissipated.receipt.stop_disposition).toBe("certified");
    expect(dissipated.receipt.frontier).toBe("closed");
    expect(dissipated.effective_as_of).toBe(exhausted.effective_as_of);
  });

  it("fails closed when any graph node or edge belongs to another generation", () => {
    expect(() => runAttributedActivation(capture(), {
      sha256: testSha256(),
      graph: graph([
        node("seed", { authorized_anchor: true }),
        node("stale", { generation_id: OTHER_GENERATION_ID })
      ], [edge("seed", "stale")])
    })).toThrow(/generation/u);
    expect(() => runAttributedActivation(capture(), {
      sha256: testSha256(),
      graph: graph([
        node("seed", { authorized_anchor: true }),
        node("current")
      ], [edge("seed", "current", { generation_id: OTHER_GENERATION_ID })])
    })).toThrow(/generation/u);
  });

  it("uses the receipt as-of for every stage, not a later clock", () => {
    const condition = captureQueryCondition(
      conditionDraft({ effective_as_of: "2026-08-01T00:00:00.000Z" }),
      { sha256: testSha256(), now: frozenClock(), pin: testPin() }
    );
    const trace = runAttributedActivation(condition, {
      sha256: testSha256(),
      graph: graph([
        node("seed", { authorized_anchor: true }),
        node("future", { valid_from: "2026-08-10T00:00:00.000Z" })
      ], [edge("seed", "future")])
    });

    expect(trace.effective_as_of).toBe("2026-08-01T00:00:00.000Z");
    expect(trace.receipt.opened_candidate_keys).toEqual(["seed"]);
  });
});
