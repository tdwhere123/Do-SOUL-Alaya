import { RecallPolicySchema, type RecallPolicy } from "@do-soul/alaya-protocol";
import { CoreError } from "./errors.js";

export function parseRecallPolicy(value: RecallPolicy): Readonly<RecallPolicy> {
  try {
    return Object.freeze(RecallPolicySchema.parse(value));
  } catch (error) {
    throw new CoreError("VALIDATION", "Invalid recall policy payload", { cause: error });
  }
}
