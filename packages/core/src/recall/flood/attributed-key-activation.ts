import type { SelectedSliceKeyV2 } from "./slice-key-contract.js";

export interface AttributedKeyActivationReceiptV1 {
  readonly dimension: string;
  readonly query_key_id: string;
  readonly candidate_key_id: string;
  readonly candidate_authority: SelectedSliceKeyV2["authority"];
  readonly independence_group: string;
  readonly support: number;
}

export interface AttributedKeyActivationV1 {
  readonly proposal_activation: number;
  readonly independent_support: number;
  readonly independent_source_count: number;
  readonly matched_dimensions: readonly string[];
  readonly receipts: readonly Readonly<AttributedKeyActivationReceiptV1>[];
}

type UsableSliceKey = Readonly<SelectedSliceKeyV2> & {
  readonly reliability: number;
};

export function computeAttributedKeyActivationV1(
  queryKeys: readonly Readonly<SelectedSliceKeyV2>[],
  candidateKeys: readonly Readonly<SelectedSliceKeyV2>[]
): Readonly<AttributedKeyActivationV1> {
  const queryByMatch = groupUsableQueryKeys(queryKeys);
  const strongestBySource = new Map<string, AttributedKeyActivationReceiptV1>();
  for (const candidate of candidateKeys) {
    if (!isUsable(candidate)) continue;
    const matchingQueries = queryByMatch.get(candidate.match_id) ?? [];
    for (const query of matchingQueries) {
      recordStrongest(strongestBySource, buildReceipt(query, candidate));
    }
  }
  const receipts = [...strongestBySource.values()].sort(compareReceipts);
  const supports = receipts.map((receipt) => receipt.support);
  return Object.freeze({
    proposal_activation: supports[0] ?? 0,
    independent_support: 1 - supports.reduce((product, support) => product * (1 - support), 1),
    independent_source_count: receipts.length,
    matched_dimensions: Object.freeze([...new Set(receipts.map((receipt) => receipt.dimension))].sort()),
    receipts: Object.freeze(receipts.map((receipt) => Object.freeze(receipt)))
  });
}

function groupUsableQueryKeys(
  keys: readonly Readonly<SelectedSliceKeyV2>[]
): ReadonlyMap<string, readonly UsableSliceKey[]> {
  const grouped = new Map<string, UsableSliceKey[]>();
  for (const key of keys) {
    if (!isUsable(key)) continue;
    const current = grouped.get(key.match_id) ?? [];
    current.push(key);
    grouped.set(key.match_id, current);
  }
  return grouped;
}

function isUsable(key: Readonly<SelectedSliceKeyV2>): key is UsableSliceKey {
  return key.freshness.state === "fresh" && key.reliability !== null;
}

function buildReceipt(
  query: UsableSliceKey,
  candidate: UsableSliceKey
): AttributedKeyActivationReceiptV1 {
  return {
    dimension: candidate.dimension,
    query_key_id: query.key_id,
    candidate_key_id: candidate.key_id,
    candidate_authority: candidate.authority,
    independence_group: candidate.independence_group,
    support: query.reliability * candidate.reliability
  };
}

function recordStrongest(
  bySource: Map<string, AttributedKeyActivationReceiptV1>,
  receipt: AttributedKeyActivationReceiptV1
): void {
  const current = bySource.get(receipt.independence_group);
  if (current === undefined || compareReceipts(receipt, current) < 0) {
    bySource.set(receipt.independence_group, receipt);
  }
}

function compareReceipts(
  left: AttributedKeyActivationReceiptV1,
  right: AttributedKeyActivationReceiptV1
): number {
  if (left.support !== right.support) return right.support - left.support;
  if (left.candidate_key_id !== right.candidate_key_id) {
    return left.candidate_key_id < right.candidate_key_id ? -1 : 1;
  }
  return left.query_key_id < right.query_key_id ? -1 : left.query_key_id > right.query_key_id ? 1 : 0;
}
