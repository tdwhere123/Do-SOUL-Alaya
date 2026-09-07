import { createHash } from "node:crypto";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  formatConditionalFieldDigest,
  type Derivation,
  type DerivationKind
} from "@do-soul/alaya-protocol";
import { projectLegalDerivationStep } from "../reference/bind-max-min.js";

export { projectLegalDerivationStep };

export type DerivationForest = ReadonlyMap<string, Derivation>;
export type LeafGrades = ReadonlyMap<string, number>;

export function leafDerivation(input: {
  readonly derivation_id: string;
  readonly observation_id: string;
  readonly leaf_id?: string;
  readonly source_revision?: string;
  readonly witness_id?: string;
}): Derivation {
  const leafId = input.leaf_id ?? input.observation_id;
  return Object.freeze({
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    derivation_id: clipId(input.derivation_id),
    kind: "leaf",
    children: Object.freeze([]),
    observation_ids: Object.freeze([input.observation_id]),
    leaf_ids: Object.freeze([leafId]),
    source_revisions: Object.freeze(
      input.source_revision === undefined ? [] : [input.source_revision]
    ),
    ...(input.witness_id === undefined ? {} : { witness_id: input.witness_id })
  });
}

export function joinDerivation(
  kind: Exclude<DerivationKind, "leaf">,
  children: readonly Derivation[],
  extras: {
    readonly derivation_id?: string;
    readonly witness_id?: string;
  } = {}
): Derivation {
  const only = children[0];
  if (only !== undefined && children.length === 1 && (kind === "or" || kind === "serial")) {
    return only;
  }
  const derivationId = extras.derivation_id ?? derivationIdentity(kind, children);
  return Object.freeze({
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    derivation_id: clipId(derivationId),
    kind,
    children: Object.freeze(children.map((child) => child.derivation_id)),
    observation_ids: Object.freeze(unique(children.flatMap((child) => child.observation_ids))),
    leaf_ids: Object.freeze(unique(children.flatMap((child) => child.leaf_ids))),
    source_revisions: Object.freeze(unique(children.flatMap((child) => child.source_revisions))),
    ...(extras.witness_id === undefined ? {} : { witness_id: extras.witness_id })
  });
}

export function derivationForest(rows: readonly Derivation[]): DerivationForest {
  const forest = new Map<string, Derivation>();
  for (const row of rows) forest.set(row.derivation_id, row);
  return forest;
}

export function mergeDerivations(rows: readonly Derivation[]): readonly Derivation[] {
  const uniqueRows = new Map<string, Derivation>();
  for (const row of rows) {
    if (!uniqueRows.has(row.derivation_id)) uniqueRows.set(row.derivation_id, row);
  }
  return Object.freeze([...uniqueRows.values()]);
}

export function evaluateDerivation(
  forest: DerivationForest,
  rootId: string,
  leafGrades: LeafGrades
): number | undefined {
  const current = forest.get(rootId);
  if (current === undefined) return undefined;
  if (current.kind === "leaf") {
    const leafId = current.leaf_ids[0] ?? current.derivation_id;
    return leafGrades.get(leafId) ?? leafGrades.get(current.derivation_id);
  }
  const childGrades: number[] = [];
  for (const childId of current.children) {
    const grade = evaluateDerivation(forest, childId, leafGrades);
    if (grade === undefined) {
      if (current.kind === "or") continue;
      return undefined;
    }
    childGrades.push(grade);
  }
  return projectLegalDerivationStep(current.kind, childGrades);
}

export function withdrawDerivation(
  forest: DerivationForest,
  rootId: string,
  withdrawnLeafId: string
): Derivation | undefined {
  const current = forest.get(rootId);
  if (current === undefined) return undefined;
  if (current.kind === "leaf") {
    return current.leaf_ids.includes(withdrawnLeafId) || current.derivation_id === withdrawnLeafId
      ? undefined
      : current;
  }
  const kept: Derivation[] = [];
  for (const childId of current.children) {
    const next = withdrawDerivation(forest, childId, withdrawnLeafId);
    if (next === undefined) continue;
    kept.push(next);
  }
  if (current.kind === "and" || current.kind === "serial") {
    if (kept.length !== current.children.length) return undefined;
  }
  if (kept.length === 0) return undefined;
  if (kept.length === 1 && current.kind === "or") return kept[0];
  if (kept.length === current.children.length
    && kept.every((child, index) => child.derivation_id === current.children[index])) {
    return current;
  }
  return joinDerivation(current.kind, kept, {
    derivation_id: `${current.derivation_id}-w`,
    witness_id: current.witness_id
  });
}

export function derivationsAfterWithdraw(
  rows: readonly Derivation[],
  withdrawnLeafId: string
): readonly Derivation[] {
  const forest = derivationForest(rows);
  const childIds = new Set(rows.flatMap((row) => row.children));
  const kept: Derivation[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (childIds.has(row.derivation_id)) continue;
    collectWithdrawn(forest, row.derivation_id, withdrawnLeafId, kept, seen);
  }
  return mergeDerivations(kept);
}

export function derivationIdentity(
  kind: DerivationKind,
  children: readonly Derivation[]
): string {
  return clipId(`${kind}:${children.map((child) => child.derivation_id).join("+")}`);
}

function collectWithdrawn(
  forest: DerivationForest,
  rootId: string,
  withdrawnLeafId: string,
  kept: Derivation[],
  seen: Set<string>
): void {
  const next = withdrawDerivation(forest, rootId, withdrawnLeafId);
  if (next === undefined) return;
  remember(forest, next, kept, seen);
}

function remember(
  forest: DerivationForest,
  node: Derivation,
  kept: Derivation[],
  seen: Set<string>
): void {
  if (seen.has(node.derivation_id)) return;
  seen.add(node.derivation_id);
  kept.push(node);
  for (const childId of node.children) {
    const child = forest.get(childId) ?? kept.find((row) => row.derivation_id === childId);
    if (child !== undefined) remember(forest, child, kept, seen);
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function clipId(value: string): string {
  if (value.length <= 256) return value;
  return formatConditionalFieldDigest(createHash("sha256").update(value, "utf8").digest("hex"));
}
