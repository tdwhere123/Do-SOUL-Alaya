export function isPromiseLike(value: unknown): value is Promise<unknown> {
  return value instanceof Promise || typeof (value as { readonly then?: unknown })?.then === "function";
}
