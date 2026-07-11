import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collapsePathInflow,
  compareConformantAxisRa,
  resolveConformantEvidenceBeta,
  resolveConformantFloodCapPerSource,
  resolveConformantFloodCapTotal,
  resolveConformantPathWeight
} from "../../../recall/scoring/conformant-fusion-scoring.js";

const CONFIG_ENV = [
  "ALAYA_RECALL_CONF_W_PATH",
  "ALAYA_RECALL_CONF_EVIDENCE_BETA",
  "ALAYA_RECALL_CONF_FLOOD_CAP",
  "ALAYA_RECALL_CONF_FLOOD_CAP_TOTAL"
] as const;
const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const name of CONFIG_ENV) {
    savedEnv.set(name, process.env[name]);
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of CONFIG_ENV) {
    const value = savedEnv.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  savedEnv.clear();
});

describe("conformant fusion configuration", () => {
  it("orders R_a ties by object, path, evidence, temporal, then control", () => {
    expect(compareConformantAxisRa(
      { object: 1, path: 0, evidence: 0, temporal: 0, control: 0 },
      { object: 0.5, path: 1, evidence: 1, temporal: 1, control: 1 }
    )).toBeLessThan(0);
    expect(compareConformantAxisRa(
      { object: 0.5, path: 1, evidence: 0, temporal: 0, control: 0 },
      { object: 0.5, path: 0.5, evidence: 1, temporal: 1, control: 1 }
    )).toBeLessThan(0);
    expect(compareConformantAxisRa(
      { object: 0.5, path: 0.5, evidence: 0.5, temporal: 1, control: 0 },
      { object: 0.5, path: 0.5, evidence: 0.5, temporal: 0.5, control: 1 }
    )).toBeLessThan(0);
    expect(compareConformantAxisRa(
      undefined,
      { object: 1, path: 0, evidence: 0, temporal: 0, control: 0 }
    )).toBe(0);
  });

  it("defaults tunables to bounded compositional values", () => {
    expect(resolveConformantPathWeight()).toBe(0.6);
    expect(resolveConformantEvidenceBeta()).toBe(0);
    expect(resolveConformantFloodCapPerSource()).toBe(1);
    expect(resolveConformantFloodCapTotal()).toBe(1);
  });

  it("keeps the default total cap behavior-equivalent to the prior loose cap", () => {
    const inflow = [
      { seedObjectId: "seed-a", weight: 1 },
      { seedObjectId: "seed-b", weight: 1 }
    ] as const;
    const rObjectById = new Map([["seed-a", 0.8], ["seed-b", 0.7]]);
    const defaultFlow = collapsePathInflow(
      inflow, "target", rObjectById, 1, resolveConformantFloodCapTotal(), 0.5
    );
    const priorLooseFlow = collapsePathInflow(
      inflow, "target", rObjectById, 1, 3, 0.5
    );

    expect(defaultFlow).toBeCloseTo(priorLooseFlow, 12);
    expect(defaultFlow).toBeLessThanOrEqual(1);
  });
});
