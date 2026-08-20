import type { AttributedActivationReceipt } from "@do-soul/alaya-protocol";

export function activationDisposition(input: Readonly<{
  readonly budgetRemaining: number;
  readonly unprocessedTransferable: boolean;
}>): Pick<AttributedActivationReceipt, "stop_disposition" | "frontier"> {
  if (input.budgetRemaining === 0 && input.unprocessedTransferable) {
    return Object.freeze({
      stop_disposition: "uncertified",
      frontier: "incomplete"
    });
  }
  return Object.freeze({
    stop_disposition: "certified",
    frontier: "closed"
  });
}
