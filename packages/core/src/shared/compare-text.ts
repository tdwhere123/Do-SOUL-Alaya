import { compareCodeUnits as compareText } from "@do-soul/alaya-protocol";

export { compareText };

export function sameTextSet(
  left: readonly string[],
  right: readonly string[]
): boolean {
  if (left.length !== right.length) return false;
  const canonicalRight = [...right].sort(compareText);
  return [...left].sort(compareText)
    .every((value, index) => value === canonicalRight[index]);
}
