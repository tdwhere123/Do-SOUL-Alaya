import { compareText } from "../../../shared/compare-text.js";
import {
  assertAllowedKeys,
  freezeShadow,
  isShadowRecord,
  ShadowContractError
} from "../prefix-capture/envelope.js";
import { SHADOW_FRONTIER_OPERATOR_ID } from "../prefix-capture/identity.js";

export type ShadowFrontierLayer = Readonly<{
  readonly index: number;
  readonly member_keys: readonly string[];
}>;

export type ShadowFrontierReceipt = Readonly<{
  readonly schema_version: 1;
  readonly operator_id: typeof SHADOW_FRONTIER_OPERATOR_ID;
  readonly layers: readonly ShadowFrontierLayer[];
}>;

export function parseFrontierReceipt(input: unknown): ShadowFrontierReceipt {
  if (!isShadowRecord(input)) {
    throw new ShadowContractError("frontier receipt must be an object");
  }
  assertAllowedKeys(input, ["schema_version", "operator_id", "layers"]);
  if (input.schema_version !== 1) {
    throw new ShadowContractError("frontier schema mismatch");
  }
  if (input.operator_id !== SHADOW_FRONTIER_OPERATOR_ID) {
    throw new ShadowContractError("frontier operator mismatch");
  }
  if (!Array.isArray(input.layers)) {
    throw new ShadowContractError("frontier layers must be an array");
  }
  return freezeShadow({
    schema_version: 1 as const,
    operator_id: SHADOW_FRONTIER_OPERATOR_ID,
    layers: Object.freeze(input.layers.map(parseFrontierLayer))
  });
}

function parseFrontierLayer(input: unknown, offset: number): ShadowFrontierLayer {
  if (!isShadowRecord(input)) {
    throw new ShadowContractError("frontier layer must be an object");
  }
  if ("score" in input || "gain" in input ||
      "FrontierPriority" in input || "frontier_priority" in input) {
    throw new ShadowContractError("frontier index is structure, not gain");
  }
  assertAllowedKeys(input, ["index", "member_keys"]);
  if (!Number.isInteger(input.index) || input.index !== offset + 1) {
    throw new ShadowContractError("frontier index must be the structural layer");
  }
  if (!Array.isArray(input.member_keys) ||
      input.member_keys.some((key) => typeof key !== "string" || key.length === 0)) {
    throw new ShadowContractError("frontier members must be candidate keys");
  }
  const keys = input.member_keys as string[];
  if (new Set(keys).size !== keys.length) {
    throw new ShadowContractError("frontier members must be unique");
  }
  const serialized = [...keys].sort(compareText);
  if (keys.some((key, index) => key !== serialized[index])) {
    throw new ShadowContractError("frontier members serialize by candidate_key only");
  }
  return freezeShadow({
    index: input.index,
    member_keys: Object.freeze([...keys])
  });
}
