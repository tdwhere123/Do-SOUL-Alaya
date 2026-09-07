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
  readonly association_milligrades?: number;
}): Derivation {
  const leafId = input.leaf_id ?? input.observation_id;
  return Object.freeze({
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    derivation_id: clipId(input.derivation_id),
    kind: "leaf",
    children: Object.freeze([]),
    observation_ids: Object.freeze([input.observation_id]),
    leaf_ids: Object.freeze([leafId]),
    ...(input.association_milligrades === undefined ? {} : { association_milligrades: input.association_milligrades }),
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
  if (kind === "and" || kind === "or") children = [...new Map(children.map((child) => [child.derivation_id, child])).values()]
    .sort((left, right) => left.derivation_id.localeCompare(right.derivation_id));
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
  const revised = reviseDerivations([...forest.values()], withdrawnLeafId);
  const root = revised.roots.get(rootId);
  return revised.derivations.find((node) => node.derivation_id === root);
}

export function derivationsAfterWithdraw(
  rows: readonly Derivation[],
  withdrawnLeafId: string
): readonly Derivation[] {
  return reviseDerivations(rows, withdrawnLeafId).derivations;
}

export function reviseDerivations(rows: readonly Derivation[], withdrawnLeafId: string): {
  readonly derivations: readonly Derivation[];
  readonly roots: ReadonlyMap<string, string | undefined>;
} {
  const forest = derivationForest(rows);
  const retained = new Map<string, Derivation>();
  const roots = new Map<string, string | undefined>();
  const visit = (id: string): Derivation | undefined => {
    if (roots.has(id)) return retained.get(roots.get(id) ?? "");
    const node = forest.get(id);
    if (node === undefined) return undefined;
    roots.set(id, undefined);
    if (node.kind === "leaf") {
      if (node.leaf_ids.includes(withdrawnLeafId) || id === withdrawnLeafId) return undefined;
      retained.set(id, node);
      roots.set(id, id);
      return node;
    }
    const children = node.children.map(visit).filter((child): child is Derivation => child !== undefined);
    if (children.length === 0 || (node.kind !== "or" && children.length !== node.children.length)) return undefined;
    const next = children.every((child, index) => child.derivation_id === node.children[index])
      && children.length === node.children.length ? node : joinDerivation(node.kind, children);
    retained.set(next.derivation_id, next);
    roots.set(id, next.derivation_id);
    return next;
  };
  for (const row of rows) visit(row.derivation_id);
  return { derivations: [...retained.values()], roots };
}

export function derivationIdentity(
  kind: DerivationKind,
  children: readonly Derivation[]
): string {
  return clipId(`${kind}:${children.map((child) => child.derivation_id).join("+")}`);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function clipId(value: string): string {
  if (value.length <= 256) return value;
  return formatConditionalFieldDigest(createHash("sha256").update(value, "utf8").digest("hex"));
}
