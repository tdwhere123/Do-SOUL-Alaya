export function requireDefined<T>(
  value: T | undefined | null,
  message = "Expected defined value"
): T {
  if (value === undefined || value === null) {
    throw new Error(message);
  }
  return value;
}

export function expectDefined<T>(value: T | undefined, label = "value"): T {
  return requireDefined(value, `expected ${label} to be defined`);
}

export function requireAt<T>(
  items: ReadonlyArray<T>,
  index: number,
  message?: string
): T {
  const value = items[index];
  if (value === undefined) {
    throw new Error(message ?? `Expected item at index ${index}`);
  }
  return value;
}

export function firstDefined<T>(values: ReadonlyArray<T>, label = "values[0]"): T {
  return requireAt(values, 0, `expected ${label} to be defined`);
}

export function mockCallAt<Args extends readonly unknown[]>(
  mock: { mock: { calls: readonly Args[] } },
  callIndex = 0
): Args {
  return requireAt(mock.mock.calls, callIndex, `Expected mock call at index ${callIndex}`);
}
