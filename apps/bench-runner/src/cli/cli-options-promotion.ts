import type { ParsedFlagsState } from "./cli-options.js";

export function consumePromotionEvidencePathFlags(
  args: ReadonlyArray<string>,
  index: number,
  token: string,
  state: ParsedFlagsState
): number | undefined {
  const promotionContract = consumePathFlag(
    args, index, token, "--promotion-contract", "--promotion-contract requires a path"
  );
  if (promotionContract !== undefined) {
    state.promotionContract = promotionContract.value;
    return promotionContract.nextIndex;
  }
  const r3SpendApproval = consumePathFlag(
    args, index, token, "--r3-spend-approval", "--r3-spend-approval requires a path"
  );
  if (r3SpendApproval === undefined) return undefined;
  state.r3SpendApproval = r3SpendApproval.value;
  return r3SpendApproval.nextIndex;
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
