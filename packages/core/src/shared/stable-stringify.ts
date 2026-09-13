import { canonicalJson } from "@do-soul/alaya-protocol";

export function stableStringify(value: unknown): string {
  return value === undefined ? "undefined" : canonicalJson(value);
}
