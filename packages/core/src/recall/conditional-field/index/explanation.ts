import { createHash } from "node:crypto";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  UsageReportSchema,
  sharedProductIdentity,
  type Derivation,
  type FieldValue,
  type IndexEntry,
  type SupportRecord,
  type UsageReport,
  type Witness
} from "@do-soul/alaya-protocol";
import { joinHyperedgeOr } from "../reference/accepting-projection.js";
import { productStateNodeId } from "../reference/bind-max-min.js";
import { traceDerivationForest } from "../engine/derivation-provenance.js";

export type ExplanationSelectionInput = Readonly<{
  readonly value: FieldValue;
  readonly support?: readonly SupportRecord[];
  readonly derivations?: readonly Derivation[];
  readonly derivation_forest?: ReadonlyMap<string, Derivation>;
  readonly output_derivation_roots?: ReadonlyMap<string, readonly string[]>;
  readonly output_derivations?: Readonly<Record<string, readonly string[]>>;
  readonly page_budget: number;
  readonly expand_payload: boolean;
}>;

export function selectFeasibleWitnesses(
  witnesses: readonly Witness[],
  pageBudget: number
): readonly Witness[] {
  return joinHyperedgeOr(witnesses).filter((witness) => witness.cost <= pageBudget);
}

export function mixedPayloadGeneration(
  snapshotId: string,
  payloadGeneration: string | undefined
): boolean {
  return payloadGeneration !== undefined && payloadGeneration !== snapshotId;
}

export function explanationIdsForEntry(input: ExplanationSelectionInput): readonly string[] {
  if (!input.expand_payload) return [];
  if (input.derivation_forest !== undefined || (input.derivations !== undefined && input.derivations.length > 0)) {
    return derivationExplanationIds(input);
  }
  return witnessExplanationIds(input);
}

export function recoverExplanationForest(ids: readonly string[], rows: readonly Derivation[]): readonly Derivation[] {
  const forest = new Map(rows.map((row) => [row.derivation_id, row]));
  const traced = traceDerivationForest({ forest, roots: ids });
  return traced.complete ? [...traced.traversal.nodes.values()] : [];
}

export function omittedStructuredPayload(
  support: readonly SupportRecord[] | undefined,
  derivations: readonly Derivation[] | undefined,
  pageBudget: number
): boolean {
  if (derivations !== undefined && derivations.length > 0) {
    const roots = derivationRoots(derivations);
    const complete = roots.filter((derivation) => derivationIsComplete(derivation, support));
    if (complete.length === 0) return false;
    return complete.every((derivation) => !derivationIsFeasible(derivation, support, pageBudget));
  }
  if (support === undefined) return false;
  let complete = 0;
  let feasible = 0;
  for (const record of support) {
    for (const witness of record.witnesses) {
      if (!witness.complete) continue;
      complete += 1;
      if (witness.cost <= pageBudget) feasible += 1;
    }
  }
  return complete > 0 && feasible === 0;
}

export function outputAttributionHandle(input: Readonly<{
  readonly entry: IndexEntry;
  readonly query_id: string;
  readonly snapshot_id: string;
}>): UsageReport {
  return UsageReportSchema.parse({
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    grain: "output",
    exposure: "exposed",
    reported_use: "unknown",
    output_id: boundedOutputId(input.entry),
    ...(input.entry.object_id === undefined ? {} : { object_id: input.entry.object_id }),
    target: input.entry.target,
    query_id: input.query_id,
    snapshot_id: input.snapshot_id
  });
}

export function witnessAttributionHandle(input: Readonly<{
  readonly entry: IndexEntry;
  readonly witness_id: string;
  readonly query_id: string;
  readonly snapshot_id: string;
  readonly interpretation_id: string;
  readonly as_of: string;
}>): UsageReport {
  return UsageReportSchema.parse({
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    grain: "witness",
    exposure: "exposed",
    reported_use: "unknown",
    witness_id: input.witness_id,
    interpretation_id: input.interpretation_id,
    as_of: input.as_of,
    ...(input.entry.object_id === undefined ? {} : { object_id: input.entry.object_id }),
    target: input.entry.target,
    query_id: input.query_id,
    snapshot_id: input.snapshot_id
  });
}

function derivationExplanationIds(input: ExplanationSelectionInput): readonly string[] {
  if (input.derivation_forest !== undefined) {
    const owned = input.output_derivation_roots?.get(productStateNodeId(input.value.state)) ?? [];
    return owned.filter((id) => {
      const node = input.derivation_forest!.get(id);
      return node !== undefined && derivationIsFeasible(node, input.support, input.page_budget);
    });
  }
  const forest = input.derivations ?? [];
  const owned = new Set(input.output_derivations?.[productStateNodeId(input.value.state)] ?? []);
  const ids: string[] = [];
  for (const derivation of forest) {
    if (!owned.has(derivation.derivation_id)) continue;
    const recovered = recoverExplanationForest([derivation.derivation_id], forest);
    if (recovered.length === 0) continue;
    // Page budget omits a witness; it cannot revoke membership of this product.
    if (!derivationIsFeasible(derivation, input.support, input.page_budget)) continue;
    ids.push(derivation.derivation_id);
  }
  return ids;
}

function witnessExplanationIds(input: ExplanationSelectionInput): readonly string[] {
  if (input.support === undefined) return [];
  const ids: string[] = [];
  for (const record of input.support) {
    if (!supportBelongsTo(record, input.value)) continue;
    for (const witness of selectFeasibleWitnesses(record.witnesses, input.page_budget)) {
      ids.push(witness.witness_id);
    }
  }
  return ids;
}

function derivationRoots(derivations: readonly Derivation[]): readonly Derivation[] {
  const childIds = new Set(derivations.flatMap((derivation) => derivation.children));
  return derivations.filter((derivation) => !childIds.has(derivation.derivation_id));
}

function supportBelongsTo(record: SupportRecord, value: FieldValue): boolean {
  const named = new Set([
    record.proposition_id,
    ...record.witnesses.flatMap((witness) => [...witness.premises])
  ]);
  return named.has(productStateNodeId(value.state))
    || named.has(sharedProductIdentity(value.state));
}

function derivationIsComplete(
  derivation: Derivation,
  support: readonly SupportRecord[] | undefined
): boolean {
  const witness = witnessForDerivation(derivation, support);
  if (witness !== undefined) return witness.complete;
  return derivation.kind !== "leaf" || derivation.leaf_ids.length > 0;
}

function derivationIsFeasible(
  derivation: Derivation,
  support: readonly SupportRecord[] | undefined,
  pageBudget: number
): boolean {
  const witness = witnessForDerivation(derivation, support);
  if (witness === undefined) return derivationIsComplete(derivation, support);
  return witness.complete && witness.cost <= pageBudget;
}

function witnessForDerivation(
  derivation: Derivation,
  support: readonly SupportRecord[] | undefined
): Witness | undefined {
  if (derivation.witness_id === undefined || support === undefined) return undefined;
  for (const record of support) {
    const matched = record.witnesses.find((witness) => witness.witness_id === derivation.witness_id);
    if (matched !== undefined) return matched;
  }
  return undefined;
}

function boundedOutputId(entry: IndexEntry): string {
  const raw = [
    entry.object_id,
    entry.hypothesis_id,
    entry.output_binding,
    entry.program_state ?? "",
    entry.time_state ?? ""
  ].join(":");
  if (raw.length >= 1 && raw.length <= 256) return raw;
  return createHash("sha256").update(raw).digest("hex");
}
