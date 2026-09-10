import { createHash } from "node:crypto";
import { productSubjectId, type Derivation, type SeedActivation, type Transition } from "@do-soul/alaya-protocol";
import { productStateNodeId } from "../reference/bind-max-min.js";
import {
  assembleOrder,
  assembleProductEquation,
  incomingRules,
  type SharedRule
} from "./dependency-equations.js";
import { leafDerivation, seedDerivationIdentity } from "./path-derivation.js";
import type { BoundSourceFacts } from "./binding-environment.js";

export type GroundingProgress = Readonly<{
  readonly input_digest: string;
  readonly completed_work: number;
  readonly retained_bytes: number;
  readonly forest: ReadonlyMap<string, Derivation>;
  readonly incoming: ReadonlyMap<string, readonly SharedRule[]>;
  readonly roots: Readonly<Record<string, readonly string[]>>;
  readonly assembled: ReadonlyMap<string, Derivation>;
  readonly seed_roots: ReadonlyMap<string, Derivation>;
  readonly derivation_offset: number;
  readonly transition_offset: number;
  readonly seed_offset: number;
  readonly assemble_order: readonly string[];
  readonly assemble_offset: number;
  readonly assembly_ready: boolean;
  readonly sccs: readonly (readonly string[])[];
  readonly retained_rule_references: number;
}>;

export function groundedOutputDerivations(input: {
  readonly seeds: readonly SeedActivation[];
  readonly transitions: readonly Transition[];
  readonly derivations: readonly Derivation[];
  readonly transition_derivations: Readonly<Record<string, string>>;
  readonly allowance: number;
  readonly memory_bytes?: number;
  readonly progress?: GroundingProgress;
  readonly source_facts?: Readonly<Record<string, BoundSourceFacts>>;
}): {
  derivations: readonly Derivation[];
  roots: Readonly<Record<string, readonly string[]>>;
  work: number;
  retained_bytes: number;
  complete: boolean;
  progress: GroundingProgress;
  retained_rule_references: number;
} {
  const inputDigest = createHash("sha256").update(JSON.stringify([
    "equations-v1",
    input.seeds, input.transitions, input.derivations, input.transition_derivations,
    input.seeds.map((seed) => input.source_facts?.[productSubjectId(seed.state)]?.source_revision ?? null)
  ])).digest("hex");
  const prior = input.progress?.input_digest === inputDigest ? input.progress : undefined;
  const forest = new Map(prior?.forest);
  const incoming = new Map(prior?.incoming ?? []);
  const roots = { ...prior?.roots };
  const assembled = new Map(prior?.assembled);
  const seedRoots = new Map(prior?.seed_roots);
  let derivationOffset = prior?.derivation_offset ?? 0;
  let transitionOffset = prior?.transition_offset ?? 0;
  let seedOffset = prior?.seed_offset ?? 0;
  let assembleOrderIds = [...prior?.assemble_order ?? []];
  let assembleOffset = prior?.assemble_offset ?? 0;
  let assemblyReady = prior?.assembly_ready ?? false;
  let sccs = [...prior?.sccs ?? []];
  let retainedRuleReferences = prior?.retained_rule_references ?? 0;
  let work = 0;
  let retainedBytes = 0;
  const releasedPrior = prior === undefined ? input.progress?.retained_bytes ?? 0 : 0;
  const retain = (bytes: number): boolean => {
    if (retainedBytes + bytes > (input.memory_bytes ?? Number.MAX_SAFE_INTEGER) + releasedPrior) return false;
    retainedBytes += bytes;
    return true;
  };
  while (work < input.allowance) {
    if (derivationOffset < input.derivations.length) {
      const node = input.derivations[derivationOffset]!;
      if (!retain(64 + node.derivation_id.length * 2)) break;
      forest.set(node.derivation_id, node);
      derivationOffset += 1;
    } else if (transitionOffset < input.transitions.length) {
      // Index the shared rule once. Expanding OR children here would enumerate diamond paths.
      const edge = input.transitions[transitionOffset]!;
      if (!retain(64)) break;
      if (edge.applicable) {
        const indexed = incomingRules([edge], input.transition_derivations);
        let retainedRule = true;
        for (const [to, rules] of indexed) {
          const rule = rules[0];
          if (rule === undefined) continue;
          if (!forest.has(rule.derivation_id)) {
            const synthesized = leafDerivation({
              derivation_id: rule.derivation_id,
              observation_id: edge.relation_kind,
              leaf_id: rule.derivation_id,
              association_milligrades: edge.strength_milligrades
            });
            if (!retain(bytesFor(synthesized))) {
              retainedRule = false;
              break;
            }
            forest.set(synthesized.derivation_id, synthesized);
          }
          const priorRules = incoming.get(to) ?? [];
          if (!priorRules.some((row) => row.rule_id === rule.rule_id)) {
            incoming.set(to, [...priorRules, rule]);
            retainedRuleReferences += 1;
          }
        }
        if (!retainedRule) break;
      }
      transitionOffset += 1;
    } else if (seedOffset < input.seeds.length) {
      const seed = input.seeds[seedOffset]!;
      const key = productStateNodeId(seed.state);
      const root = leafDerivation({
        derivation_id: seedDerivationIdentity(key),
        observation_id: productSubjectId(seed.state),
        leaf_id: seedDerivationIdentity(key),
        source_revision: input.source_facts?.[productSubjectId(seed.state)]?.source_revision,
        association_milligrades: seed.milligrades
      });
      if (!retain(bytesFor(root) + bytesFor([key, root.derivation_id]))) break;
      forest.set(root.derivation_id, root);
      seedRoots.set(key, root);
      assembled.set(key, root);
      roots[key] = [root.derivation_id];
      retainedRuleReferences += 1;
      seedOffset += 1;
    } else {
      if (!assemblyReady) {
        const nodeIds = [...new Set([
          ...seedRoots.keys(),
          ...incoming.keys(),
          ...[...incoming.values()].flatMap((rules) => rules.map((rule) => rule.from))
        ])];
        const planned = assembleOrder(nodeIds, incoming, new Set(seedRoots.keys()));
        if (!retain(bytesFor(planned.order))) break;
        assembleOrderIds = [...planned.order];
        sccs = [...planned.sccs];
        assemblyReady = true;
        continue;
      }
      const product = assembleOrderIds[assembleOffset];
      if (product === undefined) break;
      const scc = sccContaining(sccs, product);
      const equation = assembleProductEquation({
        seed: seedRoots.get(product),
        incoming: incoming.get(product) ?? [],
        forest,
        assembled,
        scc,
        sccSeeds: seedRoots
      });
      if (equation.root !== undefined) {
        let retainedAll = true;
        for (const node of equation.created) {
          if (forest.has(node.derivation_id)) continue;
          if (!retain(bytesFor(node))) {
            retainedAll = false;
            break;
          }
          forest.set(node.derivation_id, node);
        }
        if (!retainedAll) break;
        assembled.set(product, equation.root);
        roots[product] = [equation.root.derivation_id];
      }
      assembleOffset += 1;
    }
    work += 1;
  }
  const progress: GroundingProgress = {
    input_digest: inputDigest,
    forest,
    incoming,
    roots,
    assembled,
    seed_roots: seedRoots,
    completed_work: (input.progress?.completed_work ?? 0) + work,
    retained_bytes: (prior?.retained_bytes ?? 0) + retainedBytes,
    derivation_offset: derivationOffset,
    transition_offset: transitionOffset,
    seed_offset: seedOffset,
    assemble_order: assembleOrderIds,
    assemble_offset: assembleOffset,
    assembly_ready: assemblyReady,
    sccs,
    retained_rule_references: retainedRuleReferences
  };
  return {
    derivations: [...forest.values()],
    roots,
    work,
    retained_bytes: retainedBytes - releasedPrior,
    progress,
    retained_rule_references: retainedRuleReferences,
    complete: derivationOffset === input.derivations.length
      && transitionOffset === input.transitions.length
      && seedOffset === input.seeds.length
      && assemblyReady
      && assembleOffset === assembleOrderIds.length
  };
}

function sccContaining(
  sccs: readonly (readonly string[])[],
  product: string
): Set<string> {
  for (const scc of sccs) {
    if (scc.includes(product)) return new Set(scc);
  }
  return new Set([product]);
}

function bytesFor(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
