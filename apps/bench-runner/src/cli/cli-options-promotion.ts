import type { ParsedFlagsState } from "./cli-options.js";

export function consumePromotionEvidencePathFlags(
  args: ReadonlyArray<string>,
  index: number,
  token: string,
  state: ParsedFlagsState
): number | undefined {
  const expansionSpendApproval = consumePathFlag(
    args,
    index,
    token,
    "--expansion-spend-approval",
    "--expansion-spend-approval requires a path"
  );
  if (expansionSpendApproval !== undefined) {
    state.expansionSpendApproval = expansionSpendApproval.value;
    return expansionSpendApproval.nextIndex;
  }
  // Historical operator flag; same field as --expansion-spend-approval.
  const historicalSpendApproval = consumePathFlag(
    args, index, token, "--r3-spend-approval", "--r3-spend-approval requires a path"
  );
  if (historicalSpendApproval === undefined) return undefined;
  state.expansionSpendApproval = historicalSpendApproval.value;
  return historicalSpendApproval.nextIndex;
}

function consumePathFlag(
  args: ReadonlyArray<string>,
  index: number,
  token: string,
  flag: string,
  errorMessage: string
): Readonly<{ value: string; nextIndex: number }> | undefined {
  if (token !== flag && !token.startsWith(`${flag}=`)) return undefined;
  const value = token.startsWith(`${flag}=`) ? token.slice(flag.length + 1) : args[index + 1];
  if (value === undefined || value.length === 0 || value.startsWith("--")) {
    throw new Error(errorMessage);
  }
  return { value, nextIndex: token.includes("=") ? index : index + 1 };
}
