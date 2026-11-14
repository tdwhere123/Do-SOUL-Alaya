import { describe, expect, it } from "vitest";
import {
  ASSOCIATION_DOMAIN_ID,
  productSubjectId,
  type Derivation,
  type SeedActivation,
  type Transition
} from "@do-soul/alaya-protocol";
import {
  capContractId,
  fieldPartitionNodeId,
  HARD_IDENTITY_CAP_CONTRACT
} from "../../../../recall/conditional-field/cap-contract.js";
import { createConditionalField } from "../../../../recall/conditional-field/engine/field-engine.js";
import { groundedOutputDerivations } from "../../../../recall/conditional-field/engine/output-derivations.js";
import { traceDerivationForest } from "../../../../recall/conditional-field/engine/derivation-provenance.js";
import { projectAcceptingIndex } from "../../../../recall/conditional-field/index/project-accepting-index.js";
import { productStateNodeId } from "../../../../recall/conditional-field/reference/bind-max-min.js";
import { defaultBudget, defaultView, productKey, SNAPSHOT_ID } from "../reference/deployment.fixture.js";

const SOFT = capContractId({
  domain_id: ASSOCIATION_DOMAIN_ID,
  normalization: "l2.dot.v1",
  transfer_id: "policy.cosine.linear.milligrade.v1",
  transfer_version: "1"
});
const HARD = capContractId(HARD_IDENTITY_CAP_CONTRACT);
const VALIDITY: Transition["validity"] = { kind: "open", valid_from: "2026-01-01T00:00:00.000Z" };
const startA = productKey("A", "h0", "default", "start");
const acceptB = productKey("B");
const acceptC = productKey("C");

describe("contract-scoped grounding explanations", () => {
  it("keeps B's own soft proof and drops a hard A→R→B splice", () => {
    const seeds = [softSeed(startA, 800), softSeed(acceptB, 900)];
    const transitions = [edge(startA, acceptB, HARD, 1000)];
    const grounded = ground(seeds, transitions);
    const index = project(seeds, transitions, grounded);
    const delivered = index.entries.find((entry) => entry.object_id === "B");
    expect(delivered?.association_milligrades).toBe(900);
    expect(index.entries.some((entry) => entry.object_id === "A")).toBe(false);
    const root = rootOf(grounded, acceptB, SOFT);
    expect(root?.kind).toBe("leaf");
    expect(root?.observation_ids).toEqual([productSubjectId(acceptB)]);
    expect(proofKinds(grounded, root!.derivation_id)).toEqual(["leaf"]);
    expect(delivered?.explanation_ids).toEqual([root?.derivation_id]);
    expect(proofMentions(grounded, root!.derivation_id, productSubjectId(startA))).toBe(false);
  });

  it("preserves a same-contract serial path to B", () => {
    const seeds = [softSeed(startA, 800)];
    const transitions = [edge(startA, acceptB, SOFT, 700)];
    const grounded = ground(seeds, transitions);
    const index = project(seeds, transitions, grounded);
    const delivered = index.entries.find((entry) => entry.object_id === "B");
    expect(delivered?.association_milligrades).toBe(700);
    const root = rootOf(grounded, acceptB, SOFT);
    expect(root?.kind).toBe("serial");
    expect(proofMentions(grounded, root!.derivation_id, productSubjectId(startA))).toBe(true);
    expect(delivered?.explanation_ids).toEqual([root?.derivation_id]);
  });

  it("leaves a hard-only destination unreachable", () => {
    const seeds = [softSeed(startA, 800)];
    const transitions = [edge(startA, acceptC, HARD, 1000)];
    const field = createConditionalField({
      interpretation: interpretation(),
      budget: defaultBudget(),
      seeds,
      transitions
    });
    expect(field.binding.kind).toBe("bound");
    if (field.binding.kind !== "bound") return;
    const value = field.binding.snapshot.values.find((row) => productSubjectId(row.state) === "C");
    expect(value?.activation).toEqual({ kind: "unreachable" });
    const grounded = ground(seeds, transitions);
    expect(rootOf(grounded, acceptC, HARD)).toBeUndefined();
    expect(project(seeds, transitions, grounded).entries.some((entry) => entry.object_id === "C")).toBe(false);
  });

  it("resumes paging with the same contract-scoped roots", () => {
    const seeds = [softSeed(startA, 800), softSeed(acceptB, 900)];
    const transitions = [edge(startA, acceptB, HARD, 1000)];
    const input = { seeds, transitions, derivations: [], transition_derivations: {} };
    const complete = groundedOutputDerivations({ ...input, allowance: 10_000 });
    expect(complete.complete).toBe(true);
    let progress = undefined as ReturnType<typeof groundedOutputDerivations>["progress"] | undefined;
    let paged;
    for (let attempt = 0; attempt < complete.work + 20; attempt += 1) {
      paged = groundedOutputDerivations({ ...input, allowance: 1, progress });
      progress = paged.progress;
      if (paged.complete) break;
    }
    expect(paged?.complete).toBe(true);
    expect(paged?.roots).toEqual(complete.roots);
    const bRoot = rootOf(complete, acceptB, SOFT);
    expect(bRoot?.kind).toBe("leaf");
    expect(proofMentions(complete, bRoot!.derivation_id, productSubjectId(startA))).toBe(false);
  });
});

function interpretation() {
  return {
    schema_version: 1 as const,
    query_id: "cross-contract-explanation",
    snapshot_id: SNAPSHOT_ID,
    status: "resolved" as const,
    program: { schema_version: 1 as const, kind: "epsilon" as const },
    view: defaultView(),
    holes: [],
    hypotheses: []
  };
}

function softSeed(state: SeedActivation["state"], milligrades: number): SeedActivation {
  return { schema_version: 1, state, milligrades, cap_contract_id: SOFT };
}

function edge(from: SeedActivation["state"], to: SeedActivation["state"], contract: string, strength: number): Transition {
  return {
    schema_version: 1,
    from,
    to,
    relation_kind: "related",
    strength_milligrades: strength,
    applicable: true,
    validity: VALIDITY,
    cap_contract_id: contract
  };
}

function ground(seeds: readonly SeedActivation[], transitions: readonly Transition[]) {
  return groundedOutputDerivations({
    seeds, transitions, derivations: [], transition_derivations: {}, allowance: 10_000
  });
}

function project(
  seeds: readonly SeedActivation[],
  transitions: readonly Transition[],
  grounded: ReturnType<typeof groundedOutputDerivations>
) {
  const field = createConditionalField({ interpretation: interpretation(), budget: defaultBudget(), seeds, transitions });
  if (field.binding.kind !== "bound") throw new Error("field binding rejected");
  return projectAcceptingIndex({
    snapshot: field.binding.snapshot,
    query_id: field.query_id,
    snapshot_id: SNAPSHOT_ID,
    result_version: "v1",
    view: defaultView(),
    budget: defaultBudget({ finalization_reserve: 100 }),
    derivations: grounded.derivations,
    output_derivations: grounded.roots,
    grounding_complete: grounded.complete
  });
}

function rootOf(
  grounded: ReturnType<typeof groundedOutputDerivations>,
  state: SeedActivation["state"],
  contract: string
): Derivation | undefined {
  const key = fieldPartitionNodeId(productStateNodeId(state), contract);
  const id = grounded.roots[key]?.[0];
  return id === undefined ? undefined : grounded.derivations.find((row) => row.derivation_id === id);
}

function proofKinds(grounded: ReturnType<typeof groundedOutputDerivations>, rootId: string): readonly string[] {
  const forest = new Map(grounded.derivations.map((row) => [row.derivation_id, row]));
  const traced = traceDerivationForest({ forest, roots: [rootId] });
  return [...traced.traversal.nodes.values()].map((row) => row.kind).sort();
}

function proofMentions(
  grounded: ReturnType<typeof groundedOutputDerivations>,
  rootId: string,
  observationId: string
): boolean {
  const forest = new Map(grounded.derivations.map((row) => [row.derivation_id, row]));
  const traced = traceDerivationForest({ forest, roots: [rootId] });
  return [...traced.traversal.nodes.values()].some((row) => row.observation_ids.includes(observationId));
}

