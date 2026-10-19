import { canonicalJson, sameSourceEvidenceRoot, sourceEvidenceRootTarget,
  projectSourceSemanticQuerySupport, sourceSemanticQueryIdentity,
  type Derivation, type IndexEntry, type SourceSemanticLibraryProof, type SourceSemanticBindingResult,
  type SourceSemanticQuerySupport, type SourceSemanticResourceLedger, type SourceSemanticLibrarySlotQualifier,
  type SourceDisclosure, type InterpretationNodeCoordinate, type SourceSemanticQuery } from "@do-soul/alaya-protocol";
import { sourceGoldRootIdentity } from "./source-semantic-library-recall.js";
import { fieldContractSha256 } from "../../shared/field-hash.js";
import { CoreError } from "../../shared/errors.js";
import { selectSourceRecallPage, improveSourceRecallPage, type SourceRecallChoice,
  type SourceRecallSelection, type SourceRecallTupleIndex, type SourceRecallEvidenceSets } from "./source-recall-selection.js";

/** A root's complete executed witness forests and necessary source bytes are indivisible. */
export type SourceSemanticLibraryPackage = Readonly<{
  entry: IndexEntry; entries: readonly IndexEntry[]; explanations: readonly Derivation[];
  proofs: readonly SourceSemanticLibraryProof[]; preview: string; source_disclosure: SourceDisclosure;
  access_position: number; payload_support: NonNullable<SourceSemanticLibrarySlotQualifier["payload_support"]>;
  selection_basis?: SourceSemanticLibrarySlotQualifier["selection_basis"];
}>;
type SelectionInput = Readonly<{
  candidates: readonly SourceSemanticLibraryPackage[];
  fits: (page: readonly SourceSemanticLibraryPackage[]) => boolean;
  fitsStandalone?: (candidate: SourceSemanticLibraryPackage, precedingSlots: number) => boolean;
  meter: SourceSemanticResourceLedger; order?: "field" | "source_access";
}>;

export function selectSourceSemanticLibraryPage(input: SelectionInput): readonly SourceSemanticLibraryPackage[] {
  return selectLibraryPage(input, false, false, false);
}
/** Bounded mechanism diagnostic; not native delivery. */
export function selectSourceSemanticLibraryPageWithPairExchange(input: SelectionInput): readonly SourceSemanticLibraryPackage[] {
  return selectLibraryPage(input, false);
}
/** Private returned-text diagnostic; the default policy remains unchanged. */
export function selectSourceSemanticLibraryPageWithReturnedTupleNovelty(input: SelectionInput): readonly SourceSemanticLibraryPackage[] {
  return selectLibraryPage(input, true);
}
/** Potential common-query evidence coverage is not a joint proof. */
export function selectSourceSemanticLibraryPageWithEvidenceSetCoverage(input: SelectionInput): readonly SourceSemanticLibraryPackage[] {
  return selectLibraryPage(input, false, input.order !== "source_access");
}

/** Ordinals borrow the canonical inventory for this synchronous policy call only. */
function nativeSelection(input: SelectionInput, novelty: boolean, evidenceSets: boolean,
  incumbent: readonly SourceSemanticLibraryPackage[] = []): SourceRecallSelection {
  const rowAt = (member: number) => member < incumbent.length ? incumbent[member]! : input.candidates[member - incumbent.length]!;
  const materialize = (choice: SourceRecallChoice): SourceSemanticLibraryPackage => ({
    ...rowAt(choice.member), selection_basis: choice.selection_basis
  });
  return {
    count: incumbent.length + input.candidates.length, entry: i => rowAt(i).entry, root: i => root(rowAt(i)),
    accessPosition: i => rowAt(i).access_position, hasMandatorySupport: i => rowAt(i).proofs.length > 0,
    support: i => {
      const row = rowAt(i);
      const bindings = row.proofs.reduce((count, proof) => count + (proof.binding_results?.length ?? 0), 0);
      const inputs = row.proofs[0]?.query.alternatives.reduce((count, alternative) => count + (alternative.evidence_inputs?.length ?? 0), 0) ?? 0;
      input.meter.charge((bindings + 1) * (inputs + 1), inputs * 64 + bindings * 8, "selection support projection");
      return support(row);
    },
    returnedTuples: () => indexReturnedTuples(input, novelty), evidenceSets: () => evidenceSets ? indexEvidenceSets(input) : undefined,
    fits: page => input.fits(page.map(materialize)),
    ...(input.fitsStandalone === undefined ? {} : { fitsStandalone: (choice: SourceRecallChoice, slots: number) => input.fitsStandalone!(materialize(choice), slots) }),
    meter: input.meter, order: input.order
  };
}
function selectLibraryPage(input: SelectionInput, novelty: boolean, evidenceSets = false, pairs = true): readonly SourceSemanticLibraryPackage[] {
  return selectSourceRecallPage(nativeSelection(input, novelty, evidenceSets), pairs && !novelty).map(choice => ({
    ...input.candidates[choice.member]!, selection_basis: choice.selection_basis
  }));
}
export function improveSourceSemanticLibraryPage(input: Pick<SelectionInput, "candidates" | "fits" | "meter"> & {
  page: readonly SourceSemanticLibraryPackage[];
}): readonly SourceSemanticLibraryPackage[] {
  // Two borrowed inventory segments avoid another candidate copy or retained mapping table.
  let selected = input.page;
  const native = nativeSelection({ ...input, fits: page => {
    const fits = input.fits(page); if (fits) selected = page; return fits;
  } }, false, false, input.page);
  improveSourceRecallPage(native, input.page.length);
  return selected;
}

function root(row: SourceSemanticLibraryPackage): string {
  return row.entry.target.kind === "source_evidence" ? sourceGoldRootIdentity(row.entry.target) : canonicalJson(row.entry.target);
}
function support(row: SourceSemanticLibraryPackage): SourceSemanticQuerySupport | undefined {
  const proof = row.proofs[0];
  return proof === undefined ? undefined : projectSourceSemanticQuerySupport(proof.query, row.proofs.flatMap(item => item.binding_results ?? []));
}

function indexEvidenceSets(input: SelectionInput): SourceRecallEvidenceSets {
  const queries = new Map<SourceSemanticQuery, string>(), roots = new Map<IndexEntry, string>();
  let query: SourceSemanticQuery | undefined, queryId: string | undefined;
  const bind = (value: unknown, phase: string): void => {
    const before = input.meter.spentBytes;
    input.meter.retain(value, phase);
    const size = input.meter.spentBytes - before;
    input.meter.charge(size, size, phase);
  };
  for (const row of input.candidates) {
    input.meter.charge(1 + row.proofs.length, 64, "evidence-set candidate identities");
    if (!roots.has(row.entry)) { bind(row.entry.target, "evidence-set root identity"); roots.set(row.entry, root(row)); }
    for (const proof of row.proofs) {
      let identity = queries.get(proof.query);
      if (identity === undefined) {
        bind(proof.query, "evidence-set query identity"); identity = sourceSemanticQueryIdentity(proof.query, fieldContractSha256); queries.set(proof.query, identity);
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
function indexReturnedTuples(input: SelectionInput, novelty: boolean): SourceRecallTupleIndex | undefined {
  if (!novelty || input.order === "source_access" || !input.candidates.some(row => row.proofs.length > 0)) return undefined;
  input.meter.charge(input.candidates.length, input.candidates.length * 16, "returned tuple candidates");
  const tuples = new Map<IndexEntry, ReadonlySet<string>>();
  for (const row of input.candidates) tuples.set(row.entry, collectReturnedTuples(row, input.meter));
  return tuples;
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
    meter.retain(interpretation.mentions, "returned tuple mention index"); meter.retain(interpretation.referents, "returned tuple mention index");
    meter.charge(interpretation.mentions.length + interpretation.referents.length,
      (interpretation.mentions.length + interpretation.referents.length) * 64, "returned tuple mention index");
    const mentions = new Map(interpretation.mentions.map(item => [item.id, item.text]));
    const referents = new Map(interpretation.referents.map(item => [item.id, item]));
    for (const binding of bindings ?? []) {
      meter.charge(1, 64, "returned tuple binding");
      const key = returnedTupleKey(proof, binding, mentions, referents, meter);
      if (key === undefined) continue;
      meter.charge(1, 24 + 4 * key.length, "returned tuple key set"); keys.add(key);
    }
  }
  return keys;
}
function proofSourceAvailable(row: SourceSemanticLibraryPackage, proof: SourceSemanticLibraryProof, meter: SourceSemanticResourceLedger): boolean {
  meter.charge(1, 64, "returned tuple source identity");
  if (proof.source_target === undefined) return false;
  const source = proof.interpretation.source, entryTarget = row.entry.target;
  meter.retain(proof.source_target, "returned tuple source identity"); meter.retain(source, "returned tuple source identity");
  if (entryTarget.kind === "source_evidence") meter.retain(entryTarget, "returned tuple source identity");
  if (proof.source_target.source_version !== source.source_version || proof.source_target.content_digest !== source.content_digest) return false;
  if (entryTarget.kind !== "source_evidence") return true;
  const roots = [sourceEvidenceRootTarget(proof.source_target), sourceEvidenceRootTarget(entryTarget)];
  retainThenBound(meter, roots, "returned tuple source identity"); return sameSourceEvidenceRoot(roots[0]!, roots[1]!);
}
type Referent = SourceSemanticLibraryProof["interpretation"]["referents"][number];
function returnedTupleKey(proof: SourceSemanticLibraryProof, binding: SourceSemanticBindingResult,
  mentions: ReadonlyMap<string, string>, referents: ReadonlyMap<string, Referent>, meter: SourceSemanticResourceLedger): string | undefined {
  if (binding.kind === "answer" ? !binding.query_complete : binding.kind !== "evidence") return undefined;
  const returned = binding.returned, variables = proof.query.variables;
  meter.retain(variables, "returned tuple coordinates"); meter.charge(variables.length, variables.length * 64, "returned tuple coordinates");
  const ordered: [string, string][] = [];
  for (const variable of variables) {
    const coordinate = returned[variable.id]; if (coordinate === undefined) continue;
    const text = exactGroundedMention(coordinate, proof, mentions, referents, meter); if (text === undefined) return undefined;
    ordered.push([variable.id, text]);
  }
  if (ordered.length === 0) return undefined;
  const material = [proof.query_semantics_id, binding.alternative, binding.kind, binding.kind === "evidence" ? binding.input : null, ordered];
  retainThenBound(meter, material, "returned tuple key"); return canonicalJson(material);
}
function retainThenBound(meter: SourceSemanticResourceLedger, value: unknown, phase: string): void {
  const before = meter.spentBytes; meter.retain(value, phase); meter.charge(1, meter.spentBytes - before, phase);
}
function exactGroundedMention(coordinate: InterpretationNodeCoordinate, proof: SourceSemanticLibraryProof,
  mentions: ReadonlyMap<string, string>, referents: ReadonlyMap<string, Referent>, meter: SourceSemanticResourceLedger): string | undefined {
  meter.retain(coordinate, "returned tuple coordinate"); meter.retain(proof.source_interpretation_id, "returned tuple coordinate");
  meter.retain(proof.conditional_computation_id, "returned tuple coordinate");
  if (coordinate.packet_id !== proof.source_interpretation_id || coordinate.hypothesis_id !== proof.conditional_computation_id) return undefined;
  const referent = referents.get(coordinate.node_id); if (referent === undefined || referent.referent_kind !== "grouped") return undefined;
  meter.charge(referent.mentions.length, 0, "returned tuple mentions");
  let text: string | undefined;
  for (const id of referent.mentions) {
    const value = mentions.get(id); if (value === undefined) return undefined;
    meter.charge(1, 0, "returned tuple mentions"); if (text === undefined) text = value; else if (value !== text) return undefined;
  }
  return text;
}
