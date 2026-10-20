import type { SourceSemanticResourceLedger } from "@do-soul/alaya-protocol";

type SourceRecallPairInventory = Readonly<{
  count: number; selectedCount: number; meter: SourceSemanticResourceLedger;
  selectedRoot: (position: number) => string | undefined;
  selectedSupportCount: (position: number) => number;
  root: (member: number) => string | undefined; supportCount: (member: number) => number;
  hasExtent: (member: number) => boolean;
  belongsTo: (member: number, union: number) => boolean;
  inputs: (member: number) => ReadonlySet<string>;
}>;

/** Complementary same-root alternatives are chosen here; materialization cannot change their members. */
export function* enumerateSourceRecallPairs(input: SourceRecallPairInventory): Generator<Readonly<{ union: number; left: number; right: number }>> {
  const { meter } = input;
  for (let selected = 0; selected < input.selectedCount; selected++) {
    const root = input.selectedRoot(selected);
    if (root === undefined) continue;
    meter.charge(input.count, 0, "library pair source search");
    let union: number | undefined;
    for (let member = 0; member < input.count; member++) {
      if (input.supportCount(member) > 2 && input.root(member) === root) { union = member; break; }
    }
    if (union === undefined || input.supportCount(union) === input.selectedSupportCount(selected) || !input.hasExtent(union)) continue;
    meter.charge(input.count * input.supportCount(union), input.count * 8, "library pair singleton references");
    const singles: number[] = [];
    for (let member = 0; member < input.count; member++) if (input.supportCount(member) === 1 && input.belongsTo(member, union)) singles.push(member);
    const inputs = singles.map(input.inputs);
    for (let first = 0; first < singles.length; first++) for (let second = first + 1; second < singles.length; second++) {
      const left = inputs[first]!, right = inputs[second]!;
      meter.charge(1 + left.size + right.size, (left.size + right.size) * 8, "library proof pair enumeration");
      if (![...left].some(id => !right.has(id)) || ![...right].some(id => !left.has(id))) continue;
      meter.charge(2, 128, "library proof pair references");
      yield { union, left: singles[first]!, right: singles[second]! };
    }
  }
}
