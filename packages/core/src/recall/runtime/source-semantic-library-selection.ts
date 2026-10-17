import { canonicalJson, compareCodeUnits, SourceSemanticResourceExhausted, sameSourceEvidenceRoot, sourceEvidenceRootTarget,
  projectSourceSemanticQuerySupport, sourceSemanticQueryIdentity,
  type Derivation, type IndexEntry, type SourceSemanticLibraryProof, type SourceSemanticBindingResult,
  type SourceSemanticQuerySupport, type SourceSemanticResourceLedger, type SourceSemanticLibrarySlotQualifier,
  SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET, type SourceDisclosure, type InterpretationNodeCoordinate,
  type SourceSemanticQuery } from "@do-soul/alaya-protocol";
import { sourceGoldRootIdentity } from "./source-semantic-library-recall.js";
import { fieldContractSha256 } from "../../shared/field-hash.js";
import { CoreError } from "../../shared/errors.js";

/** A root's complete executed witness forests and necessary source bytes are indivisible. */
export type SourceSemanticLibraryPackage = Readonly<{
  entry: IndexEntry; entries: readonly IndexEntry[]; explanations: readonly Derivation[];
  proofs: readonly SourceSemanticLibraryProof[]; preview: string;
  source_disclosure: SourceDisclosure;
  access_position: number;
  payload_support: NonNullable<SourceSemanticLibrarySlotQualifier["payload_support"]>;
  selection_basis?: SourceSemanticLibrarySlotQualifier["selection_basis"];
}>;

type SelectionInput = Readonly<{
  candidates: readonly SourceSemanticLibraryPackage[];
  fits: (page: readonly SourceSemanticLibraryPackage[]) => boolean;
  /**
   * The freeze owner checks a reachable singleton, including its continuation
   * overhead and any already reserved final-page membership. A hypothetical
   * continuation-free envelope alone does not establish another final page.
   */
  fitsStandalone?: (candidate: SourceSemanticLibraryPackage, precedingSlots: number) => boolean;
  meter: SourceSemanticResourceLedger;
  order?: "field" | "source_access";
}>;
type TupleIndex = ReadonlyMap<IndexEntry, ReadonlySet<string>>;
type PageScore = (page: readonly SourceSemanticLibraryPackage[]) => readonly number[];
type EvidenceSetContext = Readonly<{ alternatives: readonly (readonly string[])[];
  roots: ReadonlyMap<IndexEntry, string> }>;

/**
 * Greedy demand coverage, then additional qualified local witnesses, then native
 * access order. Unknown cross-source identity never adds distinct-instance credit.
 * fits must encode the actual complete page, including proofs and source bytes.
 */
export function selectSourceSemanticLibraryPage(input: SelectionInput): readonly SourceSemanticLibraryPackage[] {
  return selectLibraryPage(input, false, false, false);
}

/**
 * Bounded pair trial for finite selection diagnostics, not native delivery.
 * Later unreserved pages can lose budget; remove when the objective comparison is settled.
 */
export function selectSourceSemanticLibraryPageWithPairExchange(input: SelectionInput): readonly SourceSemanticLibraryPackage[] {
  return selectLibraryPage(input, false);
}

/** Native delivery may improve reserved packages, retaining every occupied root and its position. */
export function improveSourceSemanticLibraryPage(input: Pick<SelectionInput, "candidates" | "fits" | "meter"> & {
  page: readonly SourceSemanticLibraryPackage[];
}): readonly SourceSemanticLibraryPackage[] {
  let selected = input.page;
  try {
    input.meter.charge(input.page.length + input.candidates.length,
      (input.page.length + input.candidates.length) * 24, "reserved package improvement references");
    const roots = new Set(input.page.map(root));
    const candidates = input.candidates.filter(row => roots.has(root(row)));
    const replacement = [...input.page];
    const supports = indexSupport([...input.page, ...candidates], input.meter);
    selected = replacement;
    improveCoverage(replacement, { ...input, candidates }, supports, pageScore(input, supports, undefined, undefined), root);
  } catch (error) {
    if (!(error instanceof SourceSemanticResourceExhausted)) throw error;
  }
  return selected;
}

/**
 * Private returned-text-tuple ranking over the shared page selector.
 * Named consumers: bounded mechanism tests and the native delivery diagnostic.
 * Remove this entry or replace it with the reviewed policy; do not keep a second selector.
 */
export function selectSourceSemanticLibraryPageWithReturnedTupleNovelty(
  input: SelectionInput
): readonly SourceSemanticLibraryPackage[] {
  return selectLibraryPage(input, true);
}

/**
 * Experimental potential evidence-set coverage for one admitted Q; never a joint proof.
 * Named consumers: bounded evidence-set tests and the native full-response diagnostic.
 * Remove after that decision or replace with the reviewed policy; the default stays unchanged.
 */
export function selectSourceSemanticLibraryPageWithEvidenceSetCoverage(
  input: SelectionInput
): readonly SourceSemanticLibraryPackage[] {
  return selectLibraryPage(input, false, input.order !== "source_access");
}

function selectLibraryPage(input: SelectionInput, novelty: boolean, evidenceSets = false, pairs = true): readonly SourceSemanticLibraryPackage[] {
  const workBefore = input.meter.spentWork;
  const selected: SourceSemanticLibraryPackage[] = [];
  const covered = new Set<string>();
  const coveredTuples = new Set<string>();
  let answered = false;
  const remaining = new Set(input.candidates);
  const supports = new Map<IndexEntry, SourceSemanticQuerySupport | undefined>();
  try {
    const tuples = indexReturnedTuples(input, novelty);
    const evidence = evidenceSets ? indexEvidenceSets(input) : undefined;
    const rootKey = (row: SourceSemanticLibraryPackage) => evidence?.roots.get(row.entry) ?? root(row);
    indexSupport(input.candidates, input.meter, supports);
    const score = pageScore(input, supports, tuples, evidence);
    const proofsByRoot = new Map<string, SourceSemanticLibraryPackage[]>();
    for (const row of input.candidates) {
      if (row.proofs.length === 0) continue;
      input.meter.charge(1, 8, "proof root reservation reference");
      const key = rootKey(row), proofs = proofsByRoot.get(key) ?? [];
      proofs.push(row); proofsByRoot.set(key, proofs);
    }
    while (selected.length < SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET && remaining.size > 0) {
      input.meter.charge(remaining.size, remaining.size * 16, "evidence selection candidates");
      const novelGain = tupleGains(remaining, tuples, coveredTuples, input.meter);
      const evidenceScores = evidence === undefined ? undefined
        : new Map([...remaining].map(row => [row.entry, score([...selected, row])]));
      const ranked = [...remaining].sort((left, right) => {
        if (input.order === "source_access") return left.access_position - right.access_position;
        const a = supports.get(left.entry), b = supports.get(right.entry);
        if (evidenceScores !== undefined) return compareScores(evidenceScores.get(left.entry)!, evidenceScores.get(right.entry)!)
          || (qualified(a) ? compareCodeUnits(rootKey(left), rootKey(right))
            : left.access_position - right.access_position || compareCodeUnits(rootKey(left), rootKey(right)));
        const answer = answered ? 0 : Number(b?.answer === "supported") - Number(a?.answer === "supported");
        const gain = demands(b).filter(id => !covered.has(id)).length - demands(a).filter(id => !covered.has(id)).length;
        const witness = Number(qualified(b)) - Number(qualified(a));
        const novel = novelGain === undefined ? 0 : (novelGain.get(right.entry) ?? 0) - (novelGain.get(left.entry) ?? 0);
        return answer || gain || witness || novel || (qualified(a) ? compareCodeUnits(root(left), root(right))
          : left.access_position - right.access_position || compareCodeUnits(root(left), root(right)));
      });
      let accepted = false;
      for (const candidate of ranked) {
        remaining.delete(candidate);
        const support = supports.get(candidate.entry);
        const selection_basis = !answered && support?.answer === "supported" ? "direct_answer"
          : demands(support).some(id => !covered.has(id)) ? "new_input" : qualified(support) ? "additional_witness" : "source_access";
        const delivered: SourceSemanticLibraryPackage = { ...candidate, selection_basis };
        if (rawProofReserved(candidate, selected.length, input, supports, proofsByRoot.get(rootKey(candidate)))) continue;
        if (!input.fits([...selected, delivered])) continue;
        selected.push(delivered);
        answered ||= support?.answer === "supported";
        for (const row of remaining) if (rootKey(row) === rootKey(candidate)) remaining.delete(row);
        for (const demand of demands(support)) covered.add(demand);
        rememberTuples(candidate.entry, tuples, coveredTuples, input.meter);
        accepted = true;
        break;
      }
      if (!accepted) break;
    }
    if (input.order !== "source_access") improveCoverage(selected, input, supports, score, rootKey,
      evidence === undefined ? undefined : proofsByRoot);
    if (pairs && !novelty && evidence === undefined && input.order !== "source_access" && selected.length > 0 && proofsByRoot.size > 0) {
      improveWithPairAllowance(input.meter, input.meter.spentWork - workBefore,
        () => improveCoverage(selected, input, supports, score, rootKey, proofsByRoot, true));
    }
  } catch (error) {
    if (!(error instanceof SourceSemanticResourceExhausted)) throw error;
    // A later candidate or continuation cannot revoke an already reserved page.
  }
  return selectionReasons(selected, supports);
}

/** The fit callback closes over this same ledger; bound its encoder work as well as the search. */
function improveWithPairAllowance(meter: SourceSemanticResourceLedger, incumbentWork: number, improve: () => void): void {
  const work = Math.min(200_000, incumbentWork, Math.floor(meter.work / 2));
  const bytes = Math.min(16_000_000, Math.floor(meter.bytes / 2));
  const heldWork = meter.work - work, heldBytes = meter.bytes - bytes;
  meter.work = work; meter.bytes = bytes;
  try { improve(); }
  catch (error) { if (!(error instanceof SourceSemanticResourceExhausted)) throw error; }
  finally { meter.work += heldWork; meter.bytes += heldBytes; }
}

function indexSupport(candidates: readonly SourceSemanticLibraryPackage[], meter: SourceSemanticResourceLedger,
  supports = new Map<IndexEntry, SourceSemanticQuerySupport | undefined>()) {
  for (const row of candidates) {
    const bindings = row.proofs.reduce((count, proof) => count + (proof.binding_results?.length ?? 0), 0);
    const inputs = row.proofs[0]?.query.alternatives.reduce((count, alternative) => count + (alternative.evidence_inputs?.length ?? 0), 0) ?? 0;
    meter.charge((bindings + 1) * (inputs + 1), inputs * 64 + bindings * 8, "selection support projection");
    supports.set(row.entry, support(row));
  }
  return supports;
}

function pageScore(input: SelectionInput, supports: ReadonlyMap<IndexEntry, SourceSemanticQuerySupport | undefined>,
  tuples: TupleIndex | undefined, evidence: EvidenceSetContext | undefined): PageScore {
  const alternatives = evidence?.alternatives;
  const requirementCount = alternatives?.reduce((count, row) => count + row.length, 0) ?? 0;
  return (page: readonly SourceSemanticLibraryPackage[]) => {
    const values = page.map(row => supports.get(row.entry));
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
    for (const row of page) {
      scanTupleKeys(tuples.get(row.entry), input.meter, "returned tuple coverage comparison", key => { union.add(key); });
    }
    return [...base, union.size];
  };
}

/** Strict local exchanges retain the existing fit owner and never infer cross-source identity. */
function improveCoverage(selected: SourceSemanticLibraryPackage[], input: SelectionInput,
  supports: ReadonlyMap<IndexEntry, SourceSemanticQuerySupport | undefined>, score: PageScore,
  rootKey: (row: SourceSemanticLibraryPackage) => string,
  proofsByRoot?: ReadonlyMap<string, readonly SourceSemanticLibraryPackage[]>, vacantSlots = false): void {
  let changed = true, searchSingles = !vacantSlots;
  if (vacantSlots) input.meter.charge(input.candidates.length * Math.max(1, Math.ceil(Math.log2(input.candidates.length))),
    input.candidates.length * 8, "pair exchange candidate order");
  const candidates = [...input.candidates].sort((left, right) => compareCodeUnits(rootKey(left), rootKey(right)));
  while (changed) {
    changed = false;
    const before = score(selected);
    exchange: for (const candidate of searchSingles ? candidates : []) for (let position = 0; position < selected.length; position++) {
      input.meter.charge(1, 0, "evidence coverage exchange");
      const page = selected.map((row, index) => index === position ? candidate : row);
      if (new Set(page.map(rootKey)).size !== page.length || compareScores(score(page), before) >= 0) continue;
      if (proofsByRoot !== undefined && rawProofReserved(candidate, position, input, supports, proofsByRoot.get(rootKey(candidate)))) continue;
      const delivered = selectionReasons(page, supports);
      if (!input.fits(delivered)) continue;
      selected.splice(0, selected.length, ...delivered); changed = true; break exchange;
    }
    searchSingles = true;
    if (!changed && proofsByRoot !== undefined) {
      changed = exchangeTwoRoots(selected, candidates, input, supports, score, before, rootKey, proofsByRoot, vacantSlots);
    }
  }
}

function exchangeTwoRoots(selected: SourceSemanticLibraryPackage[], candidates: readonly SourceSemanticLibraryPackage[],
  input: SelectionInput, supports: ReadonlyMap<IndexEntry, SourceSemanticQuerySupport | undefined>,
  score: PageScore, before: readonly number[], rootKey: (row: SourceSemanticLibraryPackage) => string,
  proofsByRoot: ReadonlyMap<string, readonly SourceSemanticLibraryPackage[]>, vacantSlots: boolean): boolean {
  for (let first = 0; first < candidates.length; first++) for (let second = first + 1; second < candidates.length; second++) {
    input.meter.charge(1, 0, "evidence pair enumeration");
    const left = candidates[first]!, right = candidates[second]!;
    if (rootKey(left) === rootKey(right)) continue;
    // Vacant slots permit replacing one root by a pair, or adding a fitting pair.
    const capacity = vacantSlots ? SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET : Math.max(2, selected.length);
    for (let a = 0; a <= selected.length && a < capacity - 1; a++)
      for (let b = a + 1; b <= selected.length + Number(a === selected.length) && b < capacity; b++) {
      const length = Math.max(selected.length, b + 1);
      input.meter.charge(length, length * 16, "evidence two-root exchange");
      const page = [...selected]; page[a] = left; page[b] = right;
      if (new Set(page.map(rootKey)).size !== page.length || compareScores(score(page), before) >= 0) continue;
      if (rawProofReserved(left, a, input, supports, proofsByRoot.get(rootKey(left)))
        || rawProofReserved(right, b, input, supports, proofsByRoot.get(rootKey(right)))) continue;
      const delivered = selectionReasons(page, supports);
      if (!input.fits(delivered)) continue;
      selected.splice(0, selected.length, ...delivered);
      return true;
    }
  }
  return false;
}

function compareScores(left: readonly number[], right: readonly number[]): number {
  const different = left.findIndex((value, index) => value !== right[index]);
  return different < 0 ? 0 : right[different]! - left[different]!;
}

function rawProofReserved(candidate: SourceSemanticLibraryPackage, precedingSlots: number, input: SelectionInput,
  supports: ReadonlyMap<IndexEntry, SourceSemanticQuerySupport | undefined>, proofs: readonly SourceSemanticLibraryPackage[] = []): boolean {
  return candidate.proofs.length === 0 && proofs.some(proof => {
    input.meter.charge(1, 0, "standalone proof reservation");
    const standalone = selectionReasons([proof], supports)[0]!;
    return input.fitsStandalone?.(standalone, precedingSlots) ?? input.fits([standalone]);
  });
}

/** The experimental objective only combines execution-owned inputs from one common admitted Q. */
function indexEvidenceSets(input: SelectionInput): EvidenceSetContext {
  const queries = new Map<SourceSemanticQuery, string>();
  const roots = new Map<IndexEntry, string>();
  let query: SourceSemanticQuery | undefined, queryId: string | undefined;
  const bind = (value: unknown, phase: string): void => {
    const before = input.meter.spentBytes;
    input.meter.retain(value, phase);
    const size = input.meter.spentBytes - before;
    input.meter.charge(size, size, phase);
  };
  for (const row of input.candidates) {
    input.meter.charge(1 + row.proofs.length, 64, "evidence-set candidate identities");
    if (!roots.has(row.entry)) {
      bind(row.entry.target, "evidence-set root identity");
      roots.set(row.entry, root(row));
    }
    for (const proof of row.proofs) {
      let identity = queries.get(proof.query);
      if (identity === undefined) {
        bind(proof.query, "evidence-set query identity");
        identity = sourceSemanticQueryIdentity(proof.query, fieldContractSha256);
        queries.set(proof.query, identity);
      }
      if (identity !== proof.query_semantics_id || queryId !== undefined && identity !== queryId) {
        throw new CoreError("VALIDATION", "evidence-set selection requires one common bound query");
      }
      query = proof.query; queryId = identity;
    }
  }
  const alternatives = (query?.alternatives ?? []).flatMap((row, alternative) => {
    const count = row.evidence_inputs?.length ?? 0;
    input.meter.charge(1 + count, count * 64, "evidence-set alternative requirements");
    return count === 0 ? [] : [Array.from({ length: count }, (_, index) => `${alternative}:${index}`)];
  });
  return { alternatives, roots };
}

function selectionReasons(page: readonly SourceSemanticLibraryPackage[], supports: ReadonlyMap<IndexEntry, SourceSemanticQuerySupport | undefined>): SourceSemanticLibraryPackage[] {
  let answered = false;
  const covered = new Set<string>();
  return page.map(row => {
    const value = supports.get(row.entry);
    const selection_basis = !answered && value?.answer === "supported" ? "direct_answer"
      : demands(value).some(id => !covered.has(id)) ? "new_input" : qualified(value) ? "additional_witness" : "source_access";
    answered ||= value?.answer === "supported";
    for (const demand of demands(value)) covered.add(demand);
    return { ...row, selection_basis };
  });
}

function root(row: SourceSemanticLibraryPackage): string {
  return row.entry.target.kind === "source_evidence" ? sourceGoldRootIdentity(row.entry.target) : canonicalJson(row.entry.target);
}
function support(row: SourceSemanticLibraryPackage): SourceSemanticQuerySupport | undefined {
  const proof = row.proofs[0];
  return proof === undefined ? undefined : projectSourceSemanticQuerySupport(proof.query,
    row.proofs.flatMap(item => item.binding_results ?? []));
}
function demands(value: SourceSemanticQuerySupport | undefined): string[] {
  return value?.evidence_inputs.filter(row => row.status === "supported").map(row => `${row.alternative}:${row.input}`) ?? [];
}
function qualified(value: SourceSemanticQuerySupport | undefined): boolean {
  return value?.answer === "supported" || demands(value).length > 0;
}

function indexReturnedTuples(input: SelectionInput, novelty: boolean): TupleIndex | undefined {
  if (!novelty || input.order === "source_access" || !input.candidates.some(row => row.proofs.length > 0)) return undefined;
  input.meter.charge(input.candidates.length, input.candidates.length * 16, "returned tuple candidates");
  const tuples = new Map<IndexEntry, ReadonlySet<string>>();
  for (const row of input.candidates) tuples.set(row.entry, collectReturnedTuples(row, input.meter));
  return tuples;
}

function rememberTuples(entry: IndexEntry, tuples: TupleIndex | undefined, covered: Set<string>,
  meter: SourceSemanticResourceLedger): void {
  scanTupleKeys(tuples?.get(entry), meter, "returned tuple coverage", key => { covered.add(key); });
}

function tupleGains(remaining: ReadonlySet<SourceSemanticLibraryPackage>, tuples: TupleIndex | undefined,
  covered: ReadonlySet<string>, meter: SourceSemanticResourceLedger): ReadonlyMap<IndexEntry, number> | undefined {
  if (tuples === undefined) return undefined;
  meter.charge(remaining.size, remaining.size * 16, "returned tuple ranking");
  const gains = new Map<IndexEntry, number>();
  for (const row of remaining) {
    let gain = 0;
    scanTupleKeys(tuples.get(row.entry), meter, "returned tuple ranking", key => { if (!covered.has(key)) gain += 1; });
    gains.set(row.entry, gain);
  }
  return gains;
}

function scanTupleKeys(keys: ReadonlySet<string> | undefined, meter: SourceSemanticResourceLedger, phase: string,
  visit: (key: string) => void): void {
  const n = keys?.size ?? 0;
  meter.charge(n, 0, phase);
  if (keys === undefined || n === 0) return;
  for (const key of keys) {
    meter.charge(0, 24 + 4 * key.length, phase);
    visit(key);
  }
}

function collectReturnedTuples(row: SourceSemanticLibraryPackage, meter: SourceSemanticResourceLedger): ReadonlySet<string> {
  const keys = new Set<string>();
  if (row.payload_support !== "available" || row.proofs.length === 0) return keys;
  const proofs = row.proofs;
  meter.charge(proofs.length, proofs.length * 64, "returned tuple observation");
  for (const proof of proofs) {
    const bindings = proof.binding_results;
    meter.charge(1, 64, "returned tuple observation");
    const count = bindings?.length ?? 0;
    meter.charge(count, count * 64, "returned tuple observation");
    if (!proofSourceAvailable(row, proof, meter) || proof.query_semantics_id === undefined
      || proof.source_interpretation_id === undefined || proof.conditional_computation_id === undefined) continue;
    const interpretation = proof.interpretation;
    meter.retain(interpretation.mentions, "returned tuple mention index");
    meter.retain(interpretation.referents, "returned tuple mention index");
    meter.charge(interpretation.mentions.length + interpretation.referents.length,
      (interpretation.mentions.length + interpretation.referents.length) * 64, "returned tuple mention index");
    const mentions = new Map(interpretation.mentions.map(item => [item.id, item.text]));
    const referents = new Map(interpretation.referents.map(item => [item.id, item]));
    for (const binding of bindings ?? []) {
      meter.charge(1, 64, "returned tuple binding");
      const key = returnedTupleKey(proof, binding, mentions, referents, meter);
      if (key === undefined) continue;
      meter.charge(1, 24 + 4 * key.length, "returned tuple key set");
      keys.add(key);
    }
  }
  return keys;
}

function proofSourceAvailable(row: SourceSemanticLibraryPackage, proof: SourceSemanticLibraryProof,
  meter: SourceSemanticResourceLedger): boolean {
  meter.charge(1, 64, "returned tuple source identity");
  if (proof.source_target === undefined) return false;
  const source = proof.interpretation.source;
  const entryTarget = row.entry.target;
  meter.retain(proof.source_target, "returned tuple source identity");
  meter.retain(source, "returned tuple source identity");
  if (entryTarget.kind === "source_evidence") meter.retain(entryTarget, "returned tuple source identity");
  if (proof.source_target.source_version !== source.source_version
    || proof.source_target.content_digest !== source.content_digest) return false;
  if (entryTarget.kind !== "source_evidence") return true;
  const roots = [sourceEvidenceRootTarget(proof.source_target), sourceEvidenceRootTarget(entryTarget)];
  retainThenBound(meter, roots, "returned tuple source identity");
  return sameSourceEvidenceRoot(roots[0]!, roots[1]!);
}

type Referent = SourceSemanticLibraryProof["interpretation"]["referents"][number];

function returnedTupleKey(proof: SourceSemanticLibraryProof, binding: SourceSemanticBindingResult,
  mentions: ReadonlyMap<string, string>, referents: ReadonlyMap<string, Referent>,
  meter: SourceSemanticResourceLedger): string | undefined {
  if (binding.kind === "answer" ? !binding.query_complete : binding.kind !== "evidence") return undefined;
  const returned = binding.returned;
  const variables = proof.query.variables;
  meter.retain(variables, "returned tuple coordinates");
  meter.charge(variables.length, variables.length * 64, "returned tuple coordinates");
  const ordered: [string, string][] = [];
  for (const variable of variables) {
    const coordinate = returned[variable.id];
    if (coordinate === undefined) continue;
    const text = exactGroundedMention(coordinate, proof, mentions, referents, meter);
    if (text === undefined) return undefined;
    ordered.push([variable.id, text]);
  }
  if (ordered.length === 0) return undefined;
  const material = [proof.query_semantics_id, binding.alternative, binding.kind,
    binding.kind === "evidence" ? binding.input : null, ordered];
  retainThenBound(meter, material, "returned tuple key");
  return canonicalJson(material);
}

function retainThenBound(meter: SourceSemanticResourceLedger, value: unknown, phase: string): void {
  const before = meter.spentBytes;
  meter.retain(value, phase);
  meter.charge(1, meter.spentBytes - before, phase);
}

function exactGroundedMention(coordinate: InterpretationNodeCoordinate, proof: SourceSemanticLibraryProof,
  mentions: ReadonlyMap<string, string>, referents: ReadonlyMap<string, Referent>,
  meter: SourceSemanticResourceLedger): string | undefined {
  meter.retain(coordinate, "returned tuple coordinate");
  meter.retain(proof.source_interpretation_id, "returned tuple coordinate");
  meter.retain(proof.conditional_computation_id, "returned tuple coordinate");
  if (coordinate.packet_id !== proof.source_interpretation_id
    || coordinate.hypothesis_id !== proof.conditional_computation_id) return undefined;
  const referent = referents.get(coordinate.node_id);
  if (referent === undefined || referent.referent_kind !== "grouped") return undefined;
  meter.charge(referent.mentions.length, 0, "returned tuple mentions");
  let text: string | undefined;
  for (const id of referent.mentions) {
    const value = mentions.get(id);
    if (value === undefined) return undefined;
    meter.charge(1, 0, "returned tuple mentions");
    if (text === undefined) text = value;
    else if (value !== text) return undefined;
  }
  return text;
}
