export type Settled<T> =
  | { readonly status: "fulfilled"; readonly value: T }
  | { readonly status: "rejected"; readonly reason: unknown };

export function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (reason: unknown) => ({ status: "rejected" as const, reason })
  );
}

export function throwFirstRejected(results: readonly Settled<unknown>[]): void {
  for (const result of results) {
    if (result.status === "rejected") {
      throw result.reason;
    }
  }
}

export function unwrapSettled<T>(result: Settled<T>): T {
  if (result.status === "rejected") {
    throw result.reason;
  }
  return result.value;
}
