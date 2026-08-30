export const SHADOW_DELIVERY_ORDER_FIELDS = [
  "selection_order",
  "ordering_basis",
  "selected_candidate_keys",
  "selected_rank",
  "FrontierPriority",
  "frontier_priority"
] as const;

export type ShadowHasDeliveryOrderField<T> = Extract<
  keyof T,
  (typeof SHADOW_DELIVERY_ORDER_FIELDS)[number]
>;

export type AssertShadowHasNoDeliveryOrder<T> =
  ShadowHasDeliveryOrderField<T> extends never ? T : never;

export class ShadowContractError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ShadowContractError";
  }
}

export function isShadowRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireShadowRecord(
  value: unknown,
  label: string
): Record<string, unknown> {
  if (!isShadowRecord(value)) {
    throw new ShadowContractError(`${label} must be an object`);
  }
  return value;
}

export function requireNonemptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ShadowContractError(`${label} is required`);
  }
  return value;
}

export function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ShadowContractError(`${label} must be finite`);
  }
  return value;
}

export function requireInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ShadowContractError(`${label} must be an integer`);
  }
  return value;
}

export function requireStringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ShadowContractError(`${label} must be a string list`);
  }
  return value;
}

export function freezeShadow<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

export function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[]
): void {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length > 0) {
    throw new ShadowContractError(`unexpected keys: ${extra.join(",")}`);
  }
}

export function assertShadowReceiptHasNoDeliveryOrder(receipt: object): void {
  for (const field of SHADOW_DELIVERY_ORDER_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(receipt, field)) {
      throw new ShadowContractError(
        `shadow receipt must not carry delivery-order field ${field}`
      );
    }
  }
}
