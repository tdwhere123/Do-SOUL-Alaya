import { canonicalJson, compareCodeUnits, SourceSemanticResourceExhausted, type Derivation, type IndexEntry, type SourceSemanticLibraryProof,
  type SourceSemanticQuerySupport, type SourceSemanticResourceLedger, type SourceSemanticLibrarySlotQualifier,
  SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET } from "@do-soul/alaya-protocol";
import { projectSourceSemanticQuerySupport } from "./source-semantic-query-support.js";
import { sourceGoldRootIdentity } from "./source-semantic-library-recall.js";

/** A root's complete executed witness forests and necessary source bytes are indivisible. */
export type SourceSemanticLibraryPackage = Readonly<{
  entry: IndexEntry; entries: readonly IndexEntry[]; explanations: readonly Derivation[];
  proofs: readonly SourceSemanticLibraryProof[]; preview: string;
  access_position: number;
  payload_support: NonNullable<SourceSemanticLibrarySlotQualifier["payload_support"]>;
  selection_basis?: SourceSemanticLibrarySlotQualifier["selection_basis"];
}>;

/**
 * Greedy demand coverage, then additional qualified local witnesses, then native
 * access order. Unknown cross-source identity never adds distinct-instance credit.
 * fits must encode the actual complete page, including proofs and source bytes.
 */
export function selectSourceSemanticLibraryPage(input: Readonly<{
  candidates: readonly SourceSemanticLibraryPackage[];
  fits: (page: readonly SourceSemanticLibraryPackage[]) => boolean;
  meter: SourceSemanticResourceLedger;
}>): readonly SourceSemanticLibraryPackage[] {
  const selected: SourceSemanticLibraryPackage[] = [];
  const covered = new Set<string>();
  let answered = false;
  const remaining = new Set(input.candidates);
  const supports = new Map<IndexEntry, SourceSemanticQuerySupport | undefined>();
  try {
    for (const row of input.candidates) {
      const bindings = row.proofs.reduce((count, proof) => count + (proof.binding_results?.length ?? 0), 0);
      const inputs = row.proofs[0]?.query.alternatives.reduce((count, alternative) => count + (alternative.evidence_inputs?.length ?? 0), 0) ?? 0;
      input.meter.charge((bindings + 1) * (inputs + 1), inputs * 64 + bindings * 8, "selection support projection");
      supports.set(row.entry, support(row));
    }
    while (selected.length < SOURCE_SEMANTIC_LIBRARY_PAGE_BUDGET && remaining.size > 0) {
      input.meter.charge(remaining.size, remaining.size * 16, "evidence selection candidates");
      const ranked = [...remaining].sort((left, right) => {
        const a = supports.get(left.entry), b = supports.get(right.entry);
        const answer = answered ? 0 : Number(b?.answer === "supported") - Number(a?.answer === "supported");
        const gain = demands(b).filter(id => !covered.has(id)).length - demands(a).filter(id => !covered.has(id)).length;
        const witness = Number(qualified(b)) - Number(qualified(a));
        return answer || gain || witness || (qualified(a) ? compareCodeUnits(root(left), root(right))
          : left.access_position - right.access_position || compareCodeUnits(root(left), root(right)));
      });
      let accepted = false;
      for (const candidate of ranked) {
        remaining.delete(candidate);
        const support = supports.get(candidate.entry);
        const selection_basis = !answered && support?.answer === "supported" ? "direct_answer"
          : demands(support).some(id => !covered.has(id)) ? "new_input" : qualified(support) ? "additional_witness" : "source_access";
        const delivered: SourceSemanticLibraryPackage = { ...candidate, selection_basis };
        if (!input.fits([...selected, delivered])) continue;
        selected.push(delivered);
        answered ||= support?.answer === "supported";
        for (const row of remaining) if (root(row) === root(candidate)) remaining.delete(row);
        for (const demand of demands(support)) covered.add(demand);
        accepted = true;
        break;
      }
      if (!accepted) break;
    }
    improveCoverage(selected, input, supports);
  } catch (error) {
    if (!(error instanceof SourceSemanticResourceExhausted)) throw error;
    // A later candidate or continuation cannot revoke an already reserved page.
  }
  return selectionReasons(selected, supports);
}

/** A bounded one-root exchange repairs greedy demand overlap; no identity inference or numeric relevance weight. */
function improveCoverage(selected: SourceSemanticLibraryPackage[], input: Parameters<typeof selectSourceSemanticLibraryPage>[0],
  supports: ReadonlyMap<IndexEntry, SourceSemanticQuerySupport | undefined>): void {
  const score = (page: readonly SourceSemanticLibraryPackage[]) => {
    const values = page.map(row => supports.get(row.entry));
    input.meter.charge(page.length + values.reduce((count, row) => count + (row?.evidence_inputs.length ?? 0), 0), page.length * 16, "evidence coverage comparison");
    return [Number(values.some(row => row?.answer === "supported")), new Set(values.flatMap(demands)).size, values.filter(qualified).length];
  };
  let changed = true;
  const candidates = [...input.candidates].sort((left, right) => compareCodeUnits(root(left), root(right)));
  while (changed) {
    changed = false;
    const before = score(selected);
    exchange: for (const candidate of candidates) for (let position = 0; position < selected.length; position++) {
      input.meter.charge(1, 0, "evidence coverage exchange");
      const page = selected.map((row, index) => index === position ? candidate : row);
      if (new Set(page.map(root)).size !== page.length) continue;
      const after = score(page), different = after.findIndex((value, index) => value !== before[index]);
      if (different < 0 || after[different]! < before[different]!) continue;
      const delivered = selectionReasons(page, supports);
      if (!input.fits(delivered)) continue;
      selected.splice(0, selected.length, ...delivered); changed = true; break exchange;
    }
  }
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
