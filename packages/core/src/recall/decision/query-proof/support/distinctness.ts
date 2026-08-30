import { ShadowContractError } from "../../contract-primitives.js";
import { verifyBindingRelationEvidenceReceiptV1 } from
  "../witness/domains/binding-evidence.js";
import type { BindingRelationEvidenceVerifierV1 } from "../witness/index.js";
import type { SupportAliasRecordV1 } from "./types.js";
import type { SupportHypergraphReceiptV1 } from "./receipt.js";

export type ProvedDistinctBindingsV1 = Readonly<{
  readonly status: "proved_distinct";
  readonly count: number;
}> | Readonly<{
  readonly status: "unknown";
  readonly reason: "incomplete_pairwise_distinctness";
}>;

export function provedDistinctBindingCount(
  receipt: SupportHypergraphReceiptV1,
  evidenceVerifier?: BindingRelationEvidenceVerifierV1
): ProvedDistinctBindingsV1 {
  for (const alias of receipt.aliases) {
    if (alias.state === "conflict") {
      throw new ShadowContractError("conflicting alias cannot prove distinctness");
    }
  }
  const equalGroups = new Map<string, string>();
  for (const node of receipt.nodes) {
    if (node.kind === "answer_binding") equalGroups.set(node.id, node.id);
  }
  for (const alias of receipt.aliases) {
    if (alias.state !== "equal") continue;
    if (!hasValidRelationEvidence(alias, receipt, "equal", evidenceVerifier)) continue;
    union(equalGroups, alias.left_id, alias.right_id);
  }
  const roots = [...new Set([...equalGroups.keys()].map((id) => find(equalGroups, id)))];
  const distinctPairs = new Set<string>();
  for (const alias of receipt.aliases) {
    if (alias.state !== "distinct") continue;
    if (!hasValidRelationEvidence(alias, receipt, "distinct", evidenceVerifier)) {
      return Object.freeze({
        status: "unknown" as const,
        reason: "incomplete_pairwise_distinctness" as const
      });
    }
    const left = find(equalGroups, alias.left_id);
    const right = find(equalGroups, alias.right_id);
    if (left === right) {
      throw new ShadowContractError("equal binding group has conflicting distinctness evidence");
    }
    distinctPairs.add(pairKey(left, right));
  }
  if (!hasCompleteDistinctnessGraph(roots, distinctPairs)) {
    return Object.freeze({
      status: "unknown" as const,
      reason: "incomplete_pairwise_distinctness" as const
    });
  }
  return Object.freeze({ status: "proved_distinct" as const, count: roots.length });
}

function hasValidRelationEvidence(
  alias: SupportAliasRecordV1,
  receipt: SupportHypergraphReceiptV1,
  relation: "equal" | "distinct",
  evidenceVerifier: BindingRelationEvidenceVerifierV1 | undefined
): boolean {
  const evidence = alias.relation_evidence_receipt;
  return evidence !== undefined &&
    evidenceVerifier !== undefined &&
    verifyBindingRelationEvidenceReceiptV1(evidence, evidenceVerifier) &&
    evidence.relation === relation &&
    evidence.query_id === receipt.query_id &&
    evidence.snapshot_digest === receipt.snapshot_digest &&
    pairKey(evidence.left_id, evidence.right_id) === pairKey(alias.left_id, alias.right_id);
}

function hasCompleteDistinctnessGraph(
  roots: readonly string[],
  distinctPairs: ReadonlySet<string>
): boolean {
  for (let left = 0; left < roots.length; left += 1) {
    for (let right = left + 1; right < roots.length; right += 1) {
      if (!distinctPairs.has(pairKey(roots[left]!, roots[right]!))) return false;
    }
  }
  return true;
}

function pairKey(left: string, right: string): string {
  return left <= right ? `${left}\0${right}` : `${right}\0${left}`;
}

function union(groups: Map<string, string>, left: string, right: string): void {
  const rootLeft = find(groups, left);
  const rootRight = find(groups, right);
  if (rootLeft !== rootRight) groups.set(rootLeft, rootRight);
}

function find(groups: Map<string, string>, id: string): string {
  const parent = groups.get(id);
  if (parent === undefined) {
    throw new ShadowContractError("alias names a missing answer_binding");
  }
  if (parent === id) return id;
  const root = find(groups, parent);
  groups.set(id, root);
  return root;
}
