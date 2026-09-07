import { createHash } from "node:crypto";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  UsageReportSchema,
  type Derivation,
  type FieldValue,
  type IndexEntry,
  type SupportRecord,
  type UsageReport,
  type Witness
} from "@do-soul/alaya-protocol";
import { joinHyperedgeOr } from "../reference/accepting-projection.js";

export type ExplanationSelectionInput = Readonly<{
  readonly value: FieldValue;
  readonly support?: readonly SupportRecord[];
  readonly derivations?: readonly Derivation[];
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
  if (input.derivations !== undefined && input.derivations.length > 0) {
    return derivationExplanationIds(input);
  }
  return witnessExplanationIds(input);
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
    object_id: input.entry.object_id,
    query_id: input.query_id,
    snapshot_id: input.snapshot_id
  });
}

export function witnessAttributionHandle(input: Readonly<{
  readonly entry: IndexEntry;
  readonly witness_id: string;
  readonly query_id: string;
  readonly snapshot_id: string;
}>): UsageReport {
  return UsageReportSchema.parse({
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    grain: "witness",
    exposure: "exposed",
    reported_use: "unknown",
    witness_id: input.witness_id,
    object_id: input.entry.object_id,
    query_id: input.query_id,
    snapshot_id: input.snapshot_id
  });
}

function derivationExplanationIds(input: ExplanationSelectionInput): readonly string[] {
  const forest = input.derivations ?? [];
  const ids: string[] = [];
  for (const derivation of derivationRoots(forest)) {
    if (!derivationBelongsTo(derivation, input.value)) continue;
    if (derivationIsRevoked(derivation, forest)) continue;
    if (!derivationIsFeasible(derivation, input.support, input.page_budget)) continue;
    ids.push(derivation.derivation_id);
  }
  return ids;
}

function derivationIsRevoked(
  derivation: Derivation,
  forest: readonly Derivation[]
): boolean {
  const latest = latestSourceRevision(
    forest.filter((candidate) => sameLeaves(candidate, derivation))
  );
  if (latest === undefined) return false;
  return !derivation.source_revisions.includes(latest);
}

function sameLeaves(left: Derivation, right: Derivation): boolean {
  if (left.leaf_ids.length !== right.leaf_ids.length) return false;
  const rightIds = new Set(right.leaf_ids);
  return left.leaf_ids.every((id) => rightIds.has(id));
}

function latestSourceRevision(forest: readonly Derivation[]): string | undefined {
  let latest: string | undefined;
  for (const derivation of forest) {
    for (const revision of derivation.source_revisions) {
      if (latest === undefined || revision > latest) latest = revision;
    }
  }
  return latest;
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

function derivationBelongsTo(derivation: Derivation, value: FieldValue): boolean {
  const named = new Set([
    ...derivation.leaf_ids,
    ...derivation.observation_ids,
    ...(derivation.witness_id === undefined ? [] : [derivation.witness_id])
  ]);
  return named.has(value.state.object_id) || named.has(value.state.hypothesis_id);
}

function supportBelongsTo(record: SupportRecord, value: FieldValue): boolean {
  const named = [record.proposition_id, ...record.witnesses.flatMap((witness) => [...witness.premises])];
  return named.includes(value.state.object_id) || named.includes(value.state.hypothesis_id);
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
