import type {
  ProductStateKey,
  Transition
} from "@do-soul/alaya-protocol";
import type { QueryRelation } from "../query/compile-query.js";
import {
  STORED_RELATION_KIND,
  SUPPORTED_RELATION_ALIASES
} from "../query/ordinary-language.js";
import {
  encodeBindingContext,
  parseBindingContext,
  unifyBinding
} from "./binding-environment.js";

export type AdjacencyRow = Readonly<{
  readonly assertionId: string;
  readonly sourceObjectId: string;
  readonly targetObjectId: string;
  readonly predicate: string;
  readonly validity?: Transition["validity"];
  readonly resolutionKind?: string | null;
}>;

export type NamedKindOverlay = Readonly<Record<string, Readonly<{
  readonly milligrades: number;
  readonly applicable: boolean;
  readonly role?: string;
}>>>;

export function relationMatches(programKind: string, storedPredicate: string): boolean {
  if (programKind === storedPredicate) return true;
  if (programKind === STORED_RELATION_KIND) return false;
  return (SUPPORTED_RELATION_ALIASES[programKind] ?? []).includes(storedPredicate);
}

export function relationStrength(
  relation: QueryRelation,
  overlay: NamedKindOverlay,
  storedPredicate: string
): Readonly<{ readonly milligrades: number; readonly applicable: boolean }> | undefined {
  return overlay[storedPredicate] ?? overlay[relation.relation_kind];
}

export function unifyAdvance(
  from: ProductStateKey,
  relation: QueryRelation,
  row: AdjacencyRow
): Readonly<{ readonly env: Map<string, string>; readonly binding: string }> | undefined {
  const source = unifyBinding(
    parseBindingContext(from.binding_context),
    relation.source_variable,
    row.sourceObjectId
  );
  if (source === undefined) return undefined;
  const target = unifyBinding(source, relation.target_variable, row.targetObjectId);
  if (target === undefined) return undefined;
  return { env: target, binding: encodeBindingContext(target) };
}

export function inactiveResolution(kind: string | null | undefined): boolean {
  return kind === "retracted" || kind === "expired" || kind === "contradicted";
}
