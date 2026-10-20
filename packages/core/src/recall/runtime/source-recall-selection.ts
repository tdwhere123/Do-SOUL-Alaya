import { compareCodeUnits, SourceSemanticResourceExhausted, SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET,
  type IndexEntry, type SourceSemanticQuerySupport, type SourceSemanticResourceLedger } from "@do-soul/alaya-protocol";

/** Request-local ordinal into the gateway's canonical candidate inventory; never a payload. */
export type SourceRecallChoice = Readonly<{ member: number;
  selection_basis: "direct_answer" | "new_input" | "additional_witness" | "source_access" }>;
export type SourceRecallTupleIndex = ReadonlyMap<IndexEntry, ReadonlySet<string>>;
export type SourceRecallEvidenceSets = Readonly<{ alternatives: readonly (readonly string[])[];
  roots: ReadonlyMap<IndexEntry, string> }>;
export type SourceRecallSelection = Readonly<{
  count: number; entry: (member: number) => IndexEntry; root: (member: number) => string;
  accessPosition: (member: number) => number; hasMandatorySupport: (member: number) => boolean;
  support: (member: number) => SourceSemanticQuerySupport | undefined;
  returnedTuples: () => SourceRecallTupleIndex | undefined;
  evidenceSets: () => SourceRecallEvidenceSets | undefined;
  fits: (page: readonly SourceRecallChoice[]) => boolean;
  fitsStandalone?: (candidate: SourceRecallChoice, precedingSlots: number) => boolean;
  meter: SourceSemanticResourceLedger; order?: "field" | "source_access";
}>;
type Supports = ReadonlyMap<IndexEntry, SourceSemanticQuerySupport | undefined>;
type PageScore = (page: readonly number[]) => readonly number[];

function* members(count: number): Generator<number> { for (let i = 0; i < count; i++) yield i; }

/** One native selection policy over source identities and execution-verified support facts. */
export function selectSourceRecallPage(input: SourceRecallSelection, pairs: boolean): readonly SourceRecallChoice[] {
  const workBefore = input.meter.spentWork;
  const selected: number[] = [], covered = new Set<string>(), coveredTuples = new Set<string>();
  let answered = false;
  const remaining = new Set(members(input.count));
  const supports = new Map<IndexEntry, SourceSemanticQuerySupport | undefined>();
  try {
    const tuples = input.returnedTuples(), evidence = input.evidenceSets();
    const rootKey = (row: number) => evidence?.roots.get(input.entry(row)) ?? input.root(row);
    for (const row of members(input.count)) supports.set(input.entry(row), input.support(row));
    const score = pageScore(input, supports, tuples, evidence);
    const proofsByRoot = new Map<string, number[]>();
    for (const row of members(input.count)) {
      if (!input.hasMandatorySupport(row)) continue;
      input.meter.charge(1, 8, "proof root reservation reference");
      const key = rootKey(row), proofs = proofsByRoot.get(key) ?? [];
      proofs.push(row); proofsByRoot.set(key, proofs);
    }
    while (selected.length < SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET && remaining.size > 0) {
      input.meter.charge(remaining.size, remaining.size * 16, "evidence selection candidates");
      const novelGain = tupleGains(remaining, tuples, coveredTuples, input);
      const evidenceScores = evidence === undefined ? undefined
        : new Map([...remaining].map(row => [input.entry(row), score([...selected, row])]));
      const ranked = [...remaining].sort((left, right) => {
        if (input.order === "source_access") return input.accessPosition(left) - input.accessPosition(right);
        const a = supports.get(input.entry(left)), b = supports.get(input.entry(right));
        if (evidenceScores !== undefined) return compareScores(evidenceScores.get(input.entry(left))!, evidenceScores.get(input.entry(right))!)
          || (qualified(a) ? compareCodeUnits(rootKey(left), rootKey(right))
            : input.accessPosition(left) - input.accessPosition(right) || compareCodeUnits(rootKey(left), rootKey(right)));
        const answer = answered ? 0 : Number(b?.answer === "supported") - Number(a?.answer === "supported");
        const gain = demands(b).filter(id => !covered.has(id)).length - demands(a).filter(id => !covered.has(id)).length;
        const witness = Number(qualified(b)) - Number(qualified(a));
        const novel = novelGain === undefined ? 0 : (novelGain.get(input.entry(right)) ?? 0) - (novelGain.get(input.entry(left)) ?? 0);
        return answer || gain || witness || novel || (qualified(a) ? compareCodeUnits(input.root(left), input.root(right))
          : input.accessPosition(left) - input.accessPosition(right) || compareCodeUnits(input.root(left), input.root(right)));
      });
      let accepted = false;
      for (const candidate of ranked) {
        remaining.delete(candidate);
        const support = supports.get(input.entry(candidate));
        const selection_basis = reason(support, answered, covered);
        if (rawProofReserved(candidate, selected.length, input, supports, proofsByRoot.get(rootKey(candidate)))) continue;
        if (!input.fits([...selectionReasons(selected, supports, input), { member: candidate, selection_basis }])) continue;
        selected.push(candidate);
        answered ||= support?.answer === "supported";
        for (const row of remaining) if (rootKey(row) === rootKey(candidate)) remaining.delete(row);
        for (const demand of demands(support)) covered.add(demand);
        scanTupleKeys(tuples?.get(input.entry(candidate)), input.meter, "returned tuple coverage", key => { coveredTuples.add(key); });
        accepted = true; break;
      }
      if (!accepted) break;
    }
    if (input.order !== "source_access") improveCoverage(selected, input, supports, score, rootKey,
      evidence === undefined ? undefined : proofsByRoot);
    if (pairs && tuples === undefined && evidence === undefined && input.order !== "source_access" && selected.length > 0 && proofsByRoot.size > 0) {
      improveWithPairAllowance(input.meter, input.meter.spentWork - workBefore,
        () => improveCoverage(selected, input, supports, score, rootKey, proofsByRoot, true));
    }
  } catch (error) { if (!(error instanceof SourceSemanticResourceExhausted)) throw error; }
  return selectionReasons(selected, supports, input);
}

/** The incumbent's occupied roots and positions survive optional same-root improvements. */
export function improveSourceRecallPage(input: SourceRecallSelection, incumbentCount: number): void {
  try {
    input.meter.charge(input.count, input.count * 24, "reserved package improvement references");
    const replacement = Array.from({ length: incumbentCount }, (_, i) => i);
    const roots = new Set(replacement.map(input.root));
    const candidates: number[] = [];
    for (let member = incumbentCount; member < input.count; member++) if (roots.has(input.root(member))) candidates.push(member);
    const supports = new Map<IndexEntry, SourceSemanticQuerySupport | undefined>();
    for (const row of replacement) supports.set(input.entry(row), input.support(row));
    for (const row of candidates) supports.set(input.entry(row), input.support(row));
    improveCoverage(replacement, input, supports, pageScore(input, supports, undefined, undefined), input.root, undefined, false, candidates);
  } catch (error) { if (!(error instanceof SourceSemanticResourceExhausted)) throw error; }
}

function improveWithPairAllowance(meter: SourceSemanticResourceLedger, incumbentWork: number, improve: () => void): void {
  const work = Math.min(200_000, incumbentWork, Math.floor(meter.work / 2));
  const bytes = Math.min(16_000_000, Math.floor(meter.bytes / 2));
  const heldWork = meter.work - work, heldBytes = meter.bytes - bytes;
  meter.work = work; meter.bytes = bytes;
  try { improve(); }
  catch (error) { if (!(error instanceof SourceSemanticResourceExhausted)) throw error; }
  finally { meter.work += heldWork; meter.bytes += heldBytes; }
}

function pageScore(input: SourceRecallSelection, supports: Supports,
  tuples: SourceRecallTupleIndex | undefined, evidence: SourceRecallEvidenceSets | undefined): PageScore {
  const alternatives = evidence?.alternatives, requirementCount = alternatives?.reduce((count, row) => count + row.length, 0) ?? 0;
  return page => {
    const values = page.map(row => supports.get(input.entry(row)));
    const inputs = values.reduce((count, row) => count + (row?.evidence_inputs.length ?? 0), 0);
    input.meter.charge(page.length + inputs + requirementCount,
      page.length * 16 + (alternatives === undefined ? 0 : inputs * 64), "evidence coverage comparison");
    const covered = new Set(values.flatMap(demands));
    const base = [Number(values.some(row => row?.answer === "supported")),
      ...(alternatives === undefined ? [] : [Number(alternatives.some(row => row.every(id => covered.has(id))))]),
      covered.size, values.filter(qualified).length];
    if (tuples === undefined) return base;
    input.meter.charge(page.length, page.length * 16, "returned tuple coverage comparison");
    const union = new Set<string>();
    for (const row of page) scanTupleKeys(tuples.get(input.entry(row)), input.meter, "returned tuple coverage comparison", key => { union.add(key); });
    return [...base, union.size];
  };
}

function improveCoverage(selected: number[], input: SourceRecallSelection, supports: Supports, score: PageScore,
  rootKey: (row: number) => string, proofsByRoot?: ReadonlyMap<string, readonly number[]>, vacantSlots = false,
  membersToImprove?: readonly number[]): void {
  let changed = true, searchSingles = !vacantSlots;
  if (vacantSlots) input.meter.charge(input.count * Math.max(1, Math.ceil(Math.log2(input.count))), input.count * 8, "pair exchange candidate order");
  const candidates = (membersToImprove === undefined ? Array.from({ length: input.count }, (_, i) => i) : [...membersToImprove])
    .sort((left, right) => compareCodeUnits(rootKey(left), rootKey(right)));
  while (changed) {
    changed = false;
    const before = score(selected);
    exchange: for (const candidate of searchSingles ? candidates : []) for (let position = 0; position < selected.length; position++) {
      input.meter.charge(1, 0, "evidence coverage exchange");
      const page = selected.map((row, index) => index === position ? candidate : row);
      if (new Set(page.map(rootKey)).size !== page.length || compareScores(score(page), before) >= 0) continue;
      if (proofsByRoot !== undefined && rawProofReserved(candidate, position, input, supports, proofsByRoot.get(rootKey(candidate)))) continue;
      if (!input.fits(selectionReasons(page, supports, input))) continue;
      selected.splice(0, selected.length, ...page); changed = true; break exchange;
    }
    searchSingles = true;
    if (!changed && proofsByRoot !== undefined) changed = exchangeTwoRoots(selected, candidates, input, supports, score, before, rootKey, proofsByRoot, vacantSlots);
  }
}

function exchangeTwoRoots(selected: number[], candidates: readonly number[], input: SourceRecallSelection, supports: Supports,
  score: PageScore, before: readonly number[], rootKey: (row: number) => string,
  proofsByRoot: ReadonlyMap<string, readonly number[]>, vacantSlots: boolean): boolean {
  for (let first = 0; first < candidates.length; first++) for (let second = first + 1; second < candidates.length; second++) {
    input.meter.charge(1, 0, "evidence pair enumeration");
    const left = candidates[first]!, right = candidates[second]!;
    if (rootKey(left) === rootKey(right)) continue;
    const capacity = vacantSlots ? SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET : Math.max(2, selected.length);
    for (let a = 0; a <= selected.length && a < capacity - 1; a++)
      for (let b = a + 1; b <= selected.length + Number(a === selected.length) && b < capacity; b++) {
        const length = Math.max(selected.length, b + 1);
        input.meter.charge(length, length * 16, "evidence two-root exchange");
        const page = [...selected]; page[a] = left; page[b] = right;
        if (new Set(page.map(rootKey)).size !== page.length || compareScores(score(page), before) >= 0) continue;
        if (rawProofReserved(left, a, input, supports, proofsByRoot.get(rootKey(left)))
          || rawProofReserved(right, b, input, supports, proofsByRoot.get(rootKey(right)))) continue;
        if (!input.fits(selectionReasons(page, supports, input))) continue;
        selected.splice(0, selected.length, ...page); return true;
      }
  }
  return false;
}

function compareScores(left: readonly number[], right: readonly number[]): number {
  const different = left.findIndex((value, index) => value !== right[index]);
  return different < 0 ? 0 : right[different]! - left[different]!;
}
function rawProofReserved(candidate: number, precedingSlots: number, input: SourceRecallSelection,
  supports: Supports, proofs: readonly number[] = []): boolean {
  return !input.hasMandatorySupport(candidate) && proofs.some(proof => {
    input.meter.charge(1, 0, "standalone proof reservation");
    const standalone = selectionReasons([proof], supports, input)[0]!;
    return input.fitsStandalone?.(standalone, precedingSlots) ?? input.fits([standalone]);
  });
}
function reason(value: SourceSemanticQuerySupport | undefined, answered: boolean, covered: ReadonlySet<string>): SourceRecallChoice["selection_basis"] {
  return !answered && value?.answer === "supported" ? "direct_answer"
    : demands(value).some(id => !covered.has(id)) ? "new_input" : qualified(value) ? "additional_witness" : "source_access";
}
function selectionReasons(page: readonly number[], supports: Supports, input: SourceRecallSelection): SourceRecallChoice[] {
  let answered = false;
  const covered = new Set<string>();
  return page.map(member => {
    const value = supports.get(input.entry(member)), selection_basis = reason(value, answered, covered);
    answered ||= value?.answer === "supported";
    for (const demand of demands(value)) covered.add(demand);
    return { member, selection_basis };
  });
}
function demands(value: SourceSemanticQuerySupport | undefined): string[] {
  return value?.evidence_inputs.filter(row => row.status === "supported").map(row => `${row.alternative}:${row.input}`) ?? [];
}
function qualified(value: SourceSemanticQuerySupport | undefined): boolean {
  return value?.answer === "supported" || demands(value).length > 0;
}
function tupleGains(remaining: ReadonlySet<number>, tuples: SourceRecallTupleIndex | undefined, covered: ReadonlySet<string>,
  input: SourceRecallSelection): ReadonlyMap<IndexEntry, number> | undefined {
  if (tuples === undefined) return undefined;
  input.meter.charge(remaining.size, remaining.size * 16, "returned tuple ranking");
  const gains = new Map<IndexEntry, number>();
  for (const row of remaining) {
    let gain = 0;
    scanTupleKeys(tuples.get(input.entry(row)), input.meter, "returned tuple ranking", key => { if (!covered.has(key)) gain += 1; });
    gains.set(input.entry(row), gain);
  }
  return gains;
}
function scanTupleKeys(keys: ReadonlySet<string> | undefined, meter: SourceSemanticResourceLedger, phase: string, visit: (key: string) => void): void {
  const n = keys?.size ?? 0;
  meter.charge(n, 0, phase);
  if (keys === undefined || n === 0) return;
  for (const key of keys) { meter.charge(0, 24 + 4 * key.length, phase); visit(key); }
}
