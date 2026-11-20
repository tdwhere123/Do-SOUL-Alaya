import {
  canonicalRuleStructureKey,
  clampGrade,
  solveBottleneckHypergraph,
  type BottleneckHypergraphInput,
  type BottleneckWitness,
  type NormalizedRule
} from "./bottleneck-hypergraph.js";

interface RuleWithSig {
  readonly sig: string;
  readonly explicitKey: string | undefined;
  readonly rule: NormalizedRule;
}

export function resolvePriorFixedPoint(
  prior: BottleneckHypergraphInput & { readonly values?: ReadonlyMap<string, number> },
  nodeIds: readonly string[],
  indexById: ReadonlyMap<string, number>,
  seeds: ReadonlyMap<number, number>,
  rules: readonly NormalizedRule[],
  top: number
): { readonly map: ReadonlyMap<string, number>; readonly arr: Float64Array } {
  if (prior.maxSettledSteps === undefined && prior.values !== undefined) {
    const arr = validatePriorValueMap(nodeIds, indexById, prior.values, top);
    if (
      !isPhiFixedPoint(nodeIds.length, seeds, rules, arr)
      || !allReachableCertified(arr, certifyEqualValueCore(nodeIds, arr, seeds, rules).inCore)
    ) {
      throw new RangeError("bottleneck hypergraph repair requires prior values to be the least fixed point");
    }
    return { map: prior.values, arr };
  }
  const map = solveBottleneckHypergraph({ ...prior, maxSettledSteps: undefined }).values;
  const arr = new Float64Array(nodeIds.length).fill(-1);
  for (let i = 0; i < nodeIds.length; i += 1) {
    const v = map.get(nodeIds[i]!);
    if (v !== undefined) arr[i] = clampGrade(v, top);
  }
  return { map, arr };
}

function validatePriorValueMap(
  nodeIds: readonly string[],
  indexById: ReadonlyMap<string, number>,
  priorValues: ReadonlyMap<string, number>,
  top: number
): Float64Array {
  const arr = new Float64Array(nodeIds.length).fill(-1);
  for (const [id, v] of priorValues) {
    const idx = indexById.get(id);
    if (idx === undefined || !Number.isInteger(v) || v < 0 || v > top) {
      throw new RangeError("bottleneck hypergraph repair requires prior values to be the least fixed point");
    }
    arr[idx] = v;
  }
  return arr;
}

function isPhiFixedPoint(
  n: number,
  seeds: ReadonlyMap<number, number>,
  rules: readonly NormalizedRule[],
  values: Float64Array
): boolean {
  const phi = new Float64Array(n).fill(-1);
  for (const [idx, grade] of seeds) if (grade > phi[idx]!) phi[idx] = grade;
  for (const r of rules) {
    let out = -1;
    if (r.kind === "and") {
      if (r.premises.length === 0) out = r.capacity;
      else {
        let minP = r.capacity;
        for (const p of r.premises) {
          if (values[p]! < 0) { minP = -1; break; }
          if (values[p]! < minP) minP = values[p]!;
        }
        out = minP;
      }
    } else if (r.kind === "or") {
      for (const p of r.premises) if (values[p]! >= 0) out = Math.max(out, Math.min(r.capacity, values[p]!));
    } else {
      const v = values[r.premises[0]!]!;
      if (v >= 0) out = Math.min(r.capacity, v);
    }
    if (out > phi[r.head]!) phi[r.head] = out;
  }
  for (let i = 0; i < n; i += 1) if (phi[i]! !== values[i]!) return false;
  return true;
}

function allReachableCertified(values: Float64Array, inCore: Uint8Array): boolean {
  for (let i = 0; i < values.length; i += 1) {
    if (values[i]! >= 0 && inCore[i] !== 1) return false;
  }
  return true;
}

export function certifyEqualValueCore(
  nodeIds: readonly string[],
  priorVal: Float64Array,
  meetSeeds: ReadonlyMap<number, number>,
  meetRules: readonly NormalizedRule[]
): {
  readonly inCore: Uint8Array;
  readonly witnesses: (BottleneckWitness | undefined)[];
  readonly certifiedCore: ReadonlySet<string>;
} {
  const n = nodeIds.length;
  const inCore = new Uint8Array(n);
  const witnesses = new Array<BottleneckWitness | undefined>(n);
  const queue: number[] = [];
  const outgoing = Array.from({ length: n }, () => [] as number[]);
  const coreRem = new Int32Array(meetRules.length);
  const andMinPrior = new Float64Array(meetRules.length).fill(-1);

  seedCoreQueue(priorVal, meetSeeds, meetRules, outgoing, coreRem, andMinPrior, inCore, witnesses, queue);
  propagateCoreQueue(nodeIds, priorVal, meetRules, outgoing, coreRem, andMinPrior, inCore, witnesses, queue);

  const certifiedCore = new Set<string>();
  for (let i = 0; i < n; i += 1) if (inCore[i] === 1) certifiedCore.add(nodeIds[i]!);
  return { inCore, witnesses, certifiedCore };
}

function seedCoreQueue(
  priorVal: Float64Array,
  meetSeeds: ReadonlyMap<number, number>,
  meetRules: readonly NormalizedRule[],
  outgoing: number[][],
  coreRem: Int32Array,
  andMinPrior: Float64Array,
  inCore: Uint8Array,
  witnesses: (BottleneckWitness | undefined)[],
  queue: number[]
): void {
  for (const [idx, val] of meetSeeds) {
    if (priorVal[idx]! >= 0 && val === priorVal[idx]! && inCore[idx] === 0) {
      inCore[idx] = 1;
      witnesses[idx] = { kind: "seed", grade: val };
      queue.push(idx);
    }
  }
  for (let i = 0; i < meetRules.length; i += 1) {
    const r = meetRules[i]!;
    coreRem[i] = r.premises.length;
    for (const p of r.premises) outgoing[p]!.push(i);
    if (r.kind !== "and") continue;
    if (r.premises.length === 0) {
      if (priorVal[r.head]! >= 0 && r.capacity === priorVal[r.head]! && inCore[r.head] === 0) {
        inCore[r.head] = 1;
        witnesses[r.head] = { kind: "rule", ruleId: r.ruleId, grade: r.capacity, premises: [] };
        queue.push(r.head);
      }
    } else {
      let minP = Number.POSITIVE_INFINITY;
      for (const p of r.premises) minP = Math.min(minP, priorVal[p]!);
      andMinPrior[i] = minP;
    }
  }
}

function propagateCoreQueue(
  nodeIds: readonly string[],
  priorVal: Float64Array,
  meetRules: readonly NormalizedRule[],
  outgoing: readonly number[][],
  coreRem: Int32Array,
  andMinPrior: Float64Array,
  inCore: Uint8Array,
  witnesses: (BottleneckWitness | undefined)[],
  queue: number[]
): void {
  for (let head = 0; head < queue.length; head += 1) {
    const u = queue[head]!;
    for (const rIdx of outgoing[u]!) {
      const r = meetRules[rIdx]!;
      const target = r.head;
      if (inCore[target] === 1 || priorVal[target]! < 0) continue;
      if (r.kind === "and") {
        const rem = coreRem[rIdx]! - 1;
        coreRem[rIdx] = rem;
        if (rem !== 0 || andMinPrior[rIdx]! < 0) continue;
        const out = Math.min(r.capacity, andMinPrior[rIdx]!);
        if (out !== priorVal[target]!) continue;
        inCore[target] = 1;
        witnesses[target] = { kind: "rule", ruleId: r.ruleId, grade: out, premises: r.premises.map((p) => nodeIds[p]!) };
        queue.push(target);
      } else {
        const out = Math.min(r.capacity, priorVal[u]!);
        if (out !== priorVal[target]!) continue;
        inCore[target] = 1;
        witnesses[target] = { kind: "rule", ruleId: r.ruleId, grade: out, premises: [nodeIds[u]!] };
        queue.push(target);
      }
    }
  }
}

export function buildConservativeMeet(
  priorIds: readonly string[],
  priorIndex: ReadonlyMap<string, number>,
  priorSeeds: ReadonlyMap<number, number>,
  priorRules: readonly NormalizedRule[],
  nextIds: readonly string[],
  nextSeeds: ReadonlyMap<number, number>,
  nextRules: readonly NormalizedRule[]
): { readonly seeds: Map<number, number>; readonly rules: NormalizedRule[]; readonly isPureDowngrade: boolean } {
  const seedMeet = buildMeetSeeds(priorIndex, priorSeeds, nextIds, nextSeeds);
  const pTagged = priorRules.map((rule): RuleWithSig => {
    const sig = ruleSignature(priorIds, rule);
    return { sig, explicitKey: rule.explicitId ? JSON.stringify([rule.ruleId, sig]) : undefined, rule };
  });
  const nTagged = nextRules.map((rule): RuleWithSig => {
    const sig = ruleSignature(nextIds, rule);
    return {
      sig,
      explicitKey: rule.explicitId ? JSON.stringify([rule.ruleId, sig]) : undefined,
      rule: remapRuleToPriorIndices(rule, nextIds, priorIndex)
    };
  });
  const meetRules: NormalizedRule[] = [];
  const usedPrior = new Uint8Array(pTagged.length);
  const usedNext = new Uint8Array(nTagged.length);
  const pureExplicit = matchRuleGroups(pTagged, nTagged, usedPrior, usedNext, meetRules, true);
  const pureRemaining = matchRuleGroups(pTagged, nTagged, usedPrior, usedNext, meetRules, false);
  return { seeds: seedMeet.seeds, rules: meetRules, isPureDowngrade: seedMeet.isPureDowngrade && pureExplicit && pureRemaining };
}

function ruleSignature(nodeIds: readonly string[], rule: NormalizedRule): string {
  return canonicalRuleStructureKey(rule.kind, nodeIds[rule.head]!, rule.premises.map((p) => nodeIds[p]!));
}

function buildMeetSeeds(
  priorIndex: ReadonlyMap<string, number>,
  priorSeeds: ReadonlyMap<number, number>,
  nextIds: readonly string[],
  nextSeeds: ReadonlyMap<number, number>
): { readonly seeds: Map<number, number>; readonly isPureDowngrade: boolean } {
  let isPureDowngrade = true;
  const seeds = new Map<number, number>();
  for (const [idx, nextVal] of nextSeeds) {
    const pIdx = priorIndex.get(nextIds[idx]!);
    const pVal = pIdx === undefined ? undefined : priorSeeds.get(pIdx);
    if (pVal === undefined || nextVal > pVal) isPureDowngrade = false;
    if (pIdx !== undefined && pVal !== undefined) seeds.set(pIdx, Math.min(pVal, nextVal));
  }
  return { seeds, isPureDowngrade };
}

function remapRuleToPriorIndices(
  rule: NormalizedRule,
  nextIds: readonly string[],
  priorIndex: ReadonlyMap<string, number>
): NormalizedRule {
  const head = priorIndex.get(nextIds[rule.head]!) ?? -1;
  const premises: number[] = [];
  for (const p of rule.premises) {
    const mapped = priorIndex.get(nextIds[p]!);
    if (mapped === undefined) return { ...rule, head: -1, premises: [] };
    premises.push(mapped);
  }
  return { ...rule, head, premises };
}

function matchRuleGroups(
  pTagged: readonly RuleWithSig[],
  nTagged: readonly RuleWithSig[],
  usedPrior: Uint8Array,
  usedNext: Uint8Array,
  meetRules: NormalizedRule[],
  explicitOnly: boolean
): boolean {
  let pure = true;
  const keyOf = (entry: RuleWithSig): string | undefined => (explicitOnly ? entry.explicitKey : entry.sig);
  const pGroups = groupUnmatched(pTagged, usedPrior, keyOf);
  const nGroups = groupUnmatched(nTagged, usedNext, keyOf);
  for (const [key, nList] of nGroups) {
    const validNext = nList.filter((item) => item.entry.rule.head >= 0);
    if (!explicitOnly && validNext.length < nList.length) pure = false;
    const pList = pGroups.get(key);
    if (pList === undefined) {
      if (!explicitOnly && validNext.length > 0) pure = false;
      continue;
    }
    pList.sort((a, b) => b.entry.rule.capacity - a.entry.rule.capacity);
    validNext.sort((a, b) => b.entry.rule.capacity - a.entry.rule.capacity);
    const matched = Math.min(pList.length, validNext.length);
    if (!explicitOnly && validNext.length > pList.length) pure = false;
    for (let k = 0; k < matched; k += 1) {
      const pItem = pList[k]!;
      const nItem = validNext[k]!;
      usedPrior[pItem.idx] = 1;
      usedNext[nItem.idx] = 1;
      if (nItem.entry.rule.capacity > pItem.entry.rule.capacity) pure = false;
      meetRules.push({
        ...pItem.entry.rule,
        ruleId: nItem.entry.rule.ruleId,
        explicitId: nItem.entry.rule.explicitId,
        capacity: Math.min(pItem.entry.rule.capacity, nItem.entry.rule.capacity)
      });
    }
  }
  return pure;
}

function groupUnmatched(
  tagged: readonly RuleWithSig[],
  used: Uint8Array,
  keyOf: (entry: RuleWithSig) => string | undefined
): Map<string, Array<{ readonly idx: number; readonly entry: RuleWithSig }>> {
  const groups = new Map<string, Array<{ readonly idx: number; readonly entry: RuleWithSig }>>();
  for (let i = 0; i < tagged.length; i += 1) {
    if (used[i] === 1) continue;
    const entry = tagged[i]!;
    const key = keyOf(entry);
    if (key === undefined) continue;
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [{ idx: i, entry }]);
    else list.push({ idx: i, entry });
  }
  return groups;
}
